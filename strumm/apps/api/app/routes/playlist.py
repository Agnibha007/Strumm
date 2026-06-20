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
from yt_dlp import YoutubeDL
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

def get_yt_playlist_entries_with_proxies(url: str) -> list:
    try:
        with YoutubeDL({"extract_flat": True, "quiet": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            if "entries" in info:
                return info["entries"]
    except Exception:
        pass

    try:
        from app.routes.stream import get_free_proxies
        proxies = get_free_proxies()
        import random
        random.shuffle(proxies)
        for proxy in proxies[:10]:
            try:
                with YoutubeDL({"extract_flat": True, "quiet": True, "proxy": f"http://{proxy}"}) as ydl:
                    info = ydl.extract_info(url, download=False)
                    if "entries" in info:
                        return info["entries"]
            except Exception:
                pass
    except Exception:
        pass
    return []

@router.post("/import")
async def import_playlist(
    payload: ImportRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        from app.routes.search import search_yt_music_songs
        database = db.get_db()
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_name = sanitize_text(payload.name, max_length=120)
        import_data = sanitize_multiline_text(payload.data, max_length=200000)
        
        parsed_rows = []
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
                for row in csv_rows:
                    if len(row) >= 2:
                        parsed_rows.append({
                            "title": row[0].strip(),
                            "artist": row[1].strip(),
                            "album": row[2].strip() if len(row) > 2 else ""
                        })
            else:
                # Normalize keys
                for row in reader:
                    normalized_row = {k.lower(): v for k, v in row.items()}
                    title = normalized_row.get("title") or normalized_row.get("name") or normalized_row.get("song", "")
                    artist = normalized_row.get("artist") or normalized_row.get("author") or normalized_row.get("singer", "")
                    album = normalized_row.get("album") or normalized_row.get("record", "")
                    parsed_rows.append({"title": title.strip(), "artist": artist.strip(), "album": album.strip()})

        elif source in ["spotify", "youtube"] and ("youtube.com" in import_data or "youtu.be" in import_data or "spotify.com" in import_data):
            # Resolve live YouTube or Spotify Playlist
            entries = get_yt_playlist_entries_with_proxies(import_data)
            is_spotify = "spotify.com" in import_data or source == "spotify"
            for entry in entries:
                title = entry.get("title")
                if title:
                    if is_spotify:
                        artist = entry.get("artist") or entry.get("creator") or entry.get("uploader") or "Various Artists"
                        parsed_rows.append({
                            "title": title,
                            "artist": artist,
                            "album": ""
                        })
                    else:
                        video_id = entry.get("id") or entry.get("url")
                        if video_id:
                            parsed_rows.append({
                                "title": title,
                                "artist": entry.get("uploader") or "Various Artists",
                                "album": "",
                                "videoId": video_id,
                                "thumbnail": entry.get("thumbnail") or f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                                "duration": entry.get("duration") or 200
                            })
        
        # If no tracks resolved but they input standard text rows, try line-by-line parsing
        if not parsed_rows and source in ["spotify", "youtube"]:
            for line in import_data.split("\n"):
                line = line.strip()
                if not line or line.startswith("http"):
                    continue
                parts = line.split(" - ")
                if len(parts) >= 2:
                    parsed_rows.append({"title": parts[0].strip(), "artist": parts[1].strip(), "album": ""})
                else:
                    parsed_rows.append({"title": line, "artist": "", "album": ""})

        for track in parsed_rows:
            title = track["title"]
            artist = track.get("artist", "")
            if not title:
                continue
                
            # If track already has video details resolved (e.g. from YouTube playlist)
            if "videoId" in track:
                song_item = {
                    "videoId": track["videoId"],
                    "title": track["title"],
                    "artist": track["artist"],
                    "thumbnail": track["thumbnail"],
                    "duration": track["duration"]
                }
                if any(x["videoId"] == song_item["videoId"] for x in matched):
                    duplicates.append(song_item)
                else:
                    matched.append(song_item)
                continue

            # 1. Search local database to see if we can resolve the song quickly
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
                # 2. Local cache miss: Search YouTube Music catalog directly!
                search_query = f"{title} {artist}".strip()
                search_matches = await search_yt_music_songs(search_query)
                if search_matches:
                    song = search_matches[0]
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
                        "album": track.get("album", "")
                    })
                    
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
