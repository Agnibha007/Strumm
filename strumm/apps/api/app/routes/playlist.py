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
            "userId": ObjectId(current_user["id"]),
            "name": payload.name,
            "description": payload.description or "",
            "songs": [],
            "visibility": payload.visibility or "private",
            "followers": 0,
            "createdAt": datetime.utcnow()
        }
        
        result = await database[db.PLAYLISTS].insert_one(new_playlist)
        new_playlist["id"] = str(result.inserted_id)
        new_playlist["userId"] = str(new_playlist["userId"])
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
        cursor = database[db.PLAYLISTS].find({"userId": ObjectId(current_user["id"])})
        playlists = []
        async for doc in cursor:
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])
            del doc["_id"]
            playlists.append(doc)
            
        return {
            "success": True,
            "data": playlists
        }
    except Exception as e:
        logger.error(f"Error fetching user playlists: {str(e)}")
        return {"success": False, "error": str(e)}

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body, BackgroundTasks

# Note: We need to import BackgroundTasks from fastapi. Let's do it locally inside get_playlist or update top imports.
# We will do it inside the endpoint or import at top. Let's import at top first or locally.
@router.get("/{id}")
async def get_playlist(
    background_tasks: BackgroundTasks,
    id: str = Path(...),
    current_user: Optional[dict] = Depends(get_current_user),
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
            
        playlist["id"] = str(playlist["_id"])
        playlist["userId"] = str(playlist["userId"])
        del playlist["_id"]
        
        # Check permissions
        if playlist["visibility"] == "private" and (not current_user or playlist["userId"] != current_user["id"]):
            return {"success": False, "error": "Access denied to private playlist"}
            
        # Warm stream resolver cache in background for top songs in playlist
        if playlist.get("songs") and background_tasks:
            try:
                from app.routes.stream import pre_resolve_tracks
                song_ids = [s["videoId"] for s in playlist["songs"] if s.get("videoId")]
                if song_ids:
                    background_tasks.add_task(pre_resolve_tracks, song_ids)
            except Exception as e:
                logger.warning(f"Failed to queue background playlist resolve: {str(e)}")

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
            
        if str(playlist["userId"]) != current_user["id"]:
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
            
        if str(playlist["userId"]) != current_user["id"]:
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

class DummyLogger:
    def debug(self, msg):
        pass
    def warning(self, msg):
        pass
    def error(self, msg):
        pass

def get_yt_playlist_entries_with_proxies(url: str) -> list:
    opts = {
        "extract_flat": True,
        "quiet": True,
        "no_warnings": True,
        "logger": DummyLogger(),
        "ignoreerrors": True
    }
    try:
        with YoutubeDL(opts) as ydl:
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
                proxy_opts = dict(opts)
                proxy_opts["proxy"] = f"http://{proxy}"
                with YoutubeDL(proxy_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    if "entries" in info:
                        return info["entries"]
            except Exception:
                pass
    except Exception:
        pass
    return []

def extract_spotify_playlist(url: str) -> list:
    import httpx
    from bs4 import BeautifulSoup
    import json
    
    playlist_id = None
    entity_type = "playlist"
    
    if "playlist/" in url:
        playlist_id = url.split("playlist/")[-1].split("?")[0].split("/")[0]
        entity_type = "playlist"
    elif "album/" in url:
        playlist_id = url.split("album/")[-1].split("?")[0].split("/")[0]
        entity_type = "album"
    elif "artist/" in url:
        playlist_id = url.split("artist/")[-1].split("?")[0].split("/")[0]
        entity_type = "artist"
    elif "track/" in url:
        playlist_id = url.split("track/")[-1].split("?")[0].split("/")[0]
        entity_type = "track"
        
    if not playlist_id:
        return []
        
    embed_url = f"https://open.spotify.com/embed/{entity_type}/{playlist_id}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        resp = httpx.get(embed_url, headers=headers, follow_redirects=True, timeout=10.0)
        if resp.status_code != 200:
            return []
            
        soup = BeautifulSoup(resp.text, "html.parser")
        next_data = soup.find("script", id="__NEXT_DATA__")
        if not next_data:
            return []
            
        data = json.loads(next_data.string)
        
        def find_tracklist(obj):
            if isinstance(obj, dict):
                if "trackList" in obj and isinstance(obj["trackList"], list):
                    return obj["trackList"]
                for k, v in obj.items():
                    res = find_tracklist(v)
                    if res:
                        return res
            elif isinstance(obj, list):
                for item in obj:
                    res = find_tracklist(item)
                    if res:
                        return res
            return None
            
        tracklist = find_tracklist(data)
        if not tracklist:
            return []
            
        parsed = []
        for t in tracklist:
            title = t.get("title")
            artists = t.get("subtitle", "")
            artists = artists.replace("\xa0", " ").strip()
            duration_ms = t.get("duration", 0)
            duration_sec = int(duration_ms / 1000) if duration_ms else 200
            
            parsed.append({
                "title": title,
                "artist": artists,
                "album": "",
                "duration": duration_sec
            })
        return parsed
    except Exception as e:
        logger.error(f"Error scraping spotify embed: {str(e)}")
        return []

def extract_ytmusic_playlist(url: str) -> list:
    from ytmusicapi import YTMusic
    
    playlist_id = None
    if "list=" in url:
        playlist_id = url.split("list=")[-1].split("&")[0]
        
    if not playlist_id:
        return []
        
    try:
        yt = YTMusic()
        playlist = yt.get_playlist(playlist_id, limit=None)
        tracks = playlist.get("tracks", [])
        parsed = []
        for t in tracks:
            title = t.get("title")
            artists = ", ".join([a.get("name") for a in t.get("artists", []) if a.get("name")])
            album = t.get("album", {}).get("name") if t.get("album") else ""
            video_id = t.get("videoId")
            duration_sec = t.get("duration_seconds") or 200
            thumbnail = t.get("thumbnails", [{}])[-1].get("url") if t.get("thumbnails") else ""
            
            item = {
                "title": title,
                "artist": artists,
                "album": album,
                "duration": duration_sec
            }
            if video_id:
                item["videoId"] = video_id
            if thumbnail:
                item["thumbnail"] = thumbnail
                
            parsed.append(item)
        return parsed
    except Exception as e:
        logger.error(f"Error fetching YTMusic playlist: {str(e)}")
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

        elif source == "spotify" or "spotify.com" in import_data:
            parsed_rows = extract_spotify_playlist(import_data)

        elif source == "youtube" or "youtube.com" in import_data or "youtu.be" in import_data:
            parsed_rows = extract_ytmusic_playlist(import_data)
            if not parsed_rows:
                # Fallback to yt-dlp flat extraction with proxy
                entries = get_yt_playlist_entries_with_proxies(import_data)
                for entry in entries:
                    title = entry.get("title")
                    if title:
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

        if not parsed_rows:
            if "spotify.com" in import_data or source == "spotify":
                return {
                    "success": False,
                    "error": "Failed to extract Spotify playlist tracks. Please make sure the playlist is public and try again."
                }
            elif import_data.strip().startswith("http"):
                return {
                    "success": False,
                    "error": "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."
                }
            else:
                return {
                    "success": False,
                    "error": "No tracks found in the provided import data. Check your format and try again."
                }

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
                "userId": ObjectId(current_user["id"]),
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
            
        if str(playlist["userId"]) != current_user["id"]:
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
