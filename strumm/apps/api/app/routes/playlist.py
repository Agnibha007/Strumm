import csv
from io import StringIO
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import PlaylistCreateSchema, PlaylistUpdateSchema, SongSchema
from app.services.security import escaped_regex, parse_object_id, sanitize_enum, sanitize_multiline_text, sanitize_text
from pydantic import BaseModel
import logging

logger = logging.getLogger("strumm-playlist")
router = APIRouter(prefix="/playlists", tags=["playlist"])

@router.post("")
async def create_playlist(
    payload: PlaylistCreateSchema,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        new_playlist = {
            "userId": current_user["id"],
            "name": payload.name,
            "description": payload.description or "",
            "songs": [],
            "visibility": payload.visibility or "private",
            "followers": 0,
            "createdAt": datetime.utcnow()
        }
        
        result = await database[db.PLAYLISTS].insert_one(new_playlist)
        new_playlist["id"] = str(result.inserted_id)
        del new_playlist["_id"]
        
        return {
            "success": True,
            "data": new_playlist
        }
    except Exception as e:
        logger.error(f"Error creating playlist: {str(e)}")
        return {"success": False, "error": f"Playlist creation failed: {str(e)}"}

@router.get("")
async def get_playlists(
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        # Find user's playlists
        cursor = database[db.PLAYLISTS].find({"userId": current_user["id"]})
        playlists = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            playlists.append(doc)
            
        return {
            "success": True,
            "data": playlists
        }
    except Exception as e:
        logger.error(f"Error fetching user playlists: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/{id}")
async def get_playlist(
    id: str = Path(...),
    current_user: Optional[dict] = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
            
        playlist["id"] = str(playlist["_id"])
        del playlist["_id"]
        
        # Check permissions
        if playlist["visibility"] == "private" and (not current_user or playlist["userId"] != current_user["id"]):
            return {"success": False, "error": "Access denied to private playlist"}
            
        return {
            "success": True,
            "data": playlist
        }
    except Exception as e:
        logger.error(f"Error resolving playlist {id}: {str(e)}")
        return {"success": False, "error": str(e)}

@router.patch("/{id}")
async def update_playlist(
    payload: PlaylistUpdateSchema,
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
            
        if playlist["userId"] != current_user["id"]:
            return {"success": False, "error": "Unauthorized to modify this playlist"}
            
        update_data = {}
        if payload.name is not None:
            update_data["name"] = payload.name
        if payload.description is not None:
            update_data["description"] = payload.description
        if payload.visibility is not None:
            update_data["visibility"] = payload.visibility
        if payload.songs is not None:
            update_data["songs"] = [s.model_dump() for s in payload.songs]
            
        if update_data:
            await database[db.PLAYLISTS].update_one({"_id": parse_object_id(id)}, {"$set": update_data})
            
        updated_playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        updated_playlist["id"] = str(updated_playlist["_id"])
        del updated_playlist["_id"]
        
        return {
            "success": True,
            "data": updated_playlist
        }
    except Exception as e:
        logger.error(f"Error updating playlist {id}: {str(e)}")
        return {"success": False, "error": str(e)}

@router.delete("/{id}")
async def delete_playlist(
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
            
        if playlist["userId"] != current_user["id"]:
            return {"success": False, "error": "Unauthorized to delete this playlist"}
            
        await database[db.PLAYLISTS].delete_one({"_id": parse_object_id(id)})
        
        return {
            "success": True,
            "data": {"message": "Playlist deleted successfully"}
        }
    except Exception as e:
        logger.error(f"Error deleting playlist {id}: {str(e)}")
        return {"success": False, "error": str(e)}

# --- PLAYLIST IMPORT ---
class ImportRequest(BaseModel):
    source: str # spotify, youtube, csv
    name: str
    data: str # URL or raw CSV string

@router.post("/import")
async def import_playlist(
    payload: ImportRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_name = sanitize_text(payload.name, max_length=120)
        import_data = sanitize_multiline_text(payload.data, max_length=200000)
        matched = []
        not_found = []
        duplicates = []
        
        if source == "csv":
            # Parse CSV content from string
            f = StringIO(import_data)
            reader = csv.DictReader(f)
            
            # If no header was recognized, try basic reader
            if not reader.fieldnames or not any(k in [x.lower() for x in reader.fieldnames] for k in ["title", "name", "song"]):
                f.seek(0)
                csv_rows = list(csv.reader(StringIO(import_data)))
                parsed_rows = []
                for row in csv_rows:
                    if len(row) >= 2:
                        parsed_rows.append({
                            "title": row[0].strip(),
                            "artist": row[1].strip(),
                            "album": row[2].strip() if len(row) > 2 else ""
                        })
            else:
                parsed_rows = []
                # Normalize keys
                for row in reader:
                    normalized_row = {k.lower(): v for k, v in row.items()}
                    title = normalized_row.get("title") or normalized_row.get("name") or normalized_row.get("song", "")
                    artist = normalized_row.get("artist") or normalized_row.get("author") or normalized_row.get("singer", "")
                    album = normalized_row.get("album") or normalized_row.get("record", "")
                    parsed_rows.append({"title": title.strip(), "artist": artist.strip(), "album": album.strip()})

            for track in parsed_rows:
                title = track["title"]
                artist = track["artist"]
                if not title:
                    continue
                    
                # Search database to see if we can resolve the song
                # Query in play history, liked songs, or matching playlist songs
                regex_title = escaped_regex(title)
                regex_artist = escaped_regex(artist) if artist else None
                
                query = {"song.title": regex_title}
                if regex_artist:
                    query["song.artist"] = regex_artist
                    
                match_doc = await database[db.LIKED_SONGS].find_one(query)
                if not match_doc:
                    query = {"songs.title": regex_title}
                    if regex_artist:
                        query["songs.artist"] = regex_artist
                    match_doc = await database[db.PLAYLISTS].find_one(query, {"songs.$": 1})
                    
                if match_doc:
                    song = match_doc["song"] if "song" in match_doc else match_doc["songs"][0]
                    # Format as SongSchema structure
                    song_item = {
                        "videoId": song["videoId"],
                        "title": song["title"],
                        "artist": song["artist"],
                        "thumbnail": song["thumbnail"],
                        "duration": song["duration"]
                    }
                    if any(x["videoId"] == song_item["videoId"] for x in matched):
                        duplicates.append(song_item)
                    else:
                        matched.append(song_item)
                else:
                    not_found.append({
                        "title": title,
                        "artist": artist,
                        "album": track["album"]
                    })
                    
        elif source in ["spotify", "youtube"]:
            # Simulate importing tracks from external link
            # In a real system, we'd call Spotify API or YT Music Scraper
            # For this startup product experience, we mock parse standard tracks
            mock_tracks = [
                {"videoId": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "artist": "Rick Astley", "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "duration": 212},
                {"videoId": "cZUvEPDYcOU", "title": "Heer", "artist": "A.R. Rahman, Harshdeep Kaur, Gulzar", "thumbnail": "https://img.youtube.com/vi/cZUvEPDYcOU/hqdefault.jpg", "duration": 314},
                {"videoId": "lOHVMmZ6n3o", "title": "Ghar Kab Aaoge", "artist": "Sonu Nigam", "thumbnail": "https://img.youtube.com/vi/lOHVMmZ6n3o/hqdefault.jpg", "duration": 191},
                {"videoId": "i-EXgX279wU", "title": "Galliyan", "artist": "Ankit Tiwari", "thumbnail": "https://img.youtube.com/vi/i-EXgX279wU/hqdefault.jpg", "duration": 341}
            ]
            
            for t in mock_tracks:
                matched.append(t)
                
        # If any matches, let's create a new playlist for the user!
        if matched:
            new_playlist = {
                "userId": current_user["id"],
                "name": f"Imported: {import_name}",
                "description": f"Imported from {source} on {datetime.utcnow().strftime('%Y-%m-%d')}",
                "songs": matched,
                "visibility": "private",
                "followers": 0,
                "createdAt": datetime.utcnow()
            }
            await database[db.PLAYLISTS].insert_one(new_playlist)
            
        return {
            "success": True,
            "data": {
                "matched": matched,
                "not_found": not_found,
                "duplicates": duplicates,
                "total_matched": len(matched),
                "total_failed": len(not_found)
            }
        }
    except Exception as e:
        logger.error(f"Error importing playlist: {str(e)}")
        return {"success": False, "error": f"Import failed: {str(e)}"}

class AddSongRequest(BaseModel):
    song: SongSchema

@router.post("/{id}/songs")
async def add_song_to_playlist(
    id: str = Path(..., description="The playlist ID to append the song to"),
    payload: AddSongRequest = Body(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
            
        if playlist["userId"] != current_user["id"]:
            return {"success": False, "error": "Unauthorized to modify this playlist"}
            
        song_dict = payload.song.model_dump()
        songs = playlist.get("songs", [])
        
        # Check duplicate
        if any(s.get("videoId") == song_dict.get("videoId") for s in songs):
            return {
                "success": False,
                "error": "Song is already in this playlist."
            }
            
        await database[db.PLAYLISTS].update_one(
            {"_id": parse_object_id(id)},
            {"$push": {"songs": song_dict}}
        )
        
        updated_playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        updated_playlist["id"] = str(updated_playlist["_id"])
        del updated_playlist["_id"]
        
        return {
            "success": True,
            "data": updated_playlist
        }
    except Exception as e:
        logger.error(f"Error adding song to playlist {id}: {str(e)}")
        return {"success": False, "error": f"Failed to add song to playlist: {str(e)}"}
