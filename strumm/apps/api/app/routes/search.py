from fastapi import APIRouter, Query, Depends
from typing import Optional, List, Dict, Any
import os
import asyncio
import httpx
from ytmusicapi import YTMusic
from app.database import mongodb as db
from app.services.podcast_index import PodcastIndexNotConfigured, search_podcasts
from app.services.security import escaped_regex, sanitize_enum, sanitize_text
import logging

logger = logging.getLogger("strumm-search")
router = APIRouter(prefix="/search", tags=["search"])

# Thread-safe helper to search YTMusic tracks
async def search_yt_music_songs(q: str) -> List[Dict[str, Any]]:
    try:
        yt = YTMusic()
        # Run synchronous call in thread pool to prevent blocking event loop
        search_results = await asyncio.to_thread(yt.search, q, filter="songs")
        songs = []
        for item in search_results:
            video_id = item.get("videoId")
            if not video_id:
                continue
            
            # Extract duration seconds
            duration_sec = item.get("duration_seconds")
            if not duration_sec and item.get("duration"):
                dur_str = item["duration"]
                try:
                    parts = list(map(int, dur_str.split(":")))
                    if len(parts) == 2:
                        duration_sec = parts[0] * 60 + parts[1]
                    elif len(parts) == 3:
                        duration_sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
                except Exception:
                    duration_sec = 200
                    
            if not duration_sec:
                duration_sec = 200
                
            artists_list = item.get("artists", [])
            artist_name = ", ".join([a.get("name", "") for a in artists_list if a.get("name")]) if artists_list else "Unknown Artist"
            
            thumbnails = item.get("thumbnails", [])
            thumb_url = thumbnails[-1].get("url", "") if thumbnails else f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
            
            album_info = item.get("album")
            album_name = album_info.get("name", "") if album_info else ""
            
            songs.append({
                "videoId": video_id,
                "title": item.get("title", "Untitled Track"),
                "artist": artist_name,
                "thumbnail": thumb_url,
                "duration": duration_sec,
                "metadata": {
                    "album": album_name
                }
            })
        return songs
    except Exception as e:
        logger.error(f"YTMusic search failed: {str(e)}")
        return []

# Helper to search YTMusic albums
async def search_yt_music_albums(q: str) -> List[Dict[str, Any]]:
    try:
        yt = YTMusic()
        search_results = await asyncio.to_thread(yt.search, q, filter="albums")
        albums = []
        for item in search_results:
            browse_id = item.get("browseId")
            if not browse_id:
                continue
            
            artists_list = item.get("artists", [])
            artist_name = ", ".join([a.get("name", "") for a in artists_list if a.get("name")]) if artists_list else "Unknown Artist"
            
            thumbnails = item.get("thumbnails", [])
            thumb_url = thumbnails[-1].get("url", "") if thumbnails else ""
            
            albums.append({
                "id": browse_id,
                "title": item.get("title", "Untitled Album"),
                "artist": artist_name,
                "thumbnail": thumb_url,
                "year": item.get("year", "")
            })
        return albums
    except Exception as e:
        logger.error(f"YTMusic album search failed: {str(e)}")
        return []

# Helper to search YTMusic artists
async def search_yt_music_artists(q: str) -> List[Dict[str, Any]]:
    try:
        yt = YTMusic()
        search_results = await asyncio.to_thread(yt.search, q, filter="artists")
        artists = []
        for item in search_results:
            browse_id = item.get("browseId")
            if not browse_id:
                continue
            
            thumbnails = item.get("thumbnails", [])
            thumb_url = thumbnails[-1].get("url", "") if thumbnails else ""
            
            artists.append({
                "id": browse_id,
                "name": item.get("artist", "Unknown Artist"),
                "thumbnail": thumb_url
            })
        return artists
    except Exception as e:
        logger.error(f"YTMusic artist search failed: {str(e)}")
        return []

async def search_podcast_index(q: str) -> List[Dict[str, Any]]:
    try:
        return await search_podcasts(q, max_results=12)
    except PodcastIndexNotConfigured:
        logger.warning("PodcastIndex credentials are not configured; podcast search returned no external results.")
    except Exception as e:
        logger.error(f"PodcastIndex search failed: {str(e)}")
    return []

# Helper to search local playlists
async def search_local_playlists(q: str) -> List[Dict[str, Any]]:
    try:
        database = db.get_db()
        regex_query = escaped_regex(q)
        playlist_cursor = database[db.PLAYLISTS].find(
            {"name": regex_query, "visibility": "public"},
            {"name": 1, "description": 1, "followers": 1, "songs": {"$slice": 1}}
        ).limit(6)
        
        playlists = []
        async for p in playlist_cursor:
            p["id"] = str(p["_id"])
            del p["_id"]
            playlists.append(p)
        return playlists
    except Exception as e:
        logger.error(f"Local playlist search failed: {str(e)}")
        return []

# Helper to search local curators
async def search_local_users(q: str) -> List[Dict[str, Any]]:
    try:
        database = db.get_db()
        regex_query = escaped_regex(q)
        user_cursor = database[db.USERS].find(
            {"displayName": regex_query, "settings.privacy": "public"},
            {"displayName": 1, "username": 1, "avatar": 1, "theme": 1}
        ).limit(6)
        
        users = []
        async for u in user_cursor:
            u["id"] = str(u["_id"])
            del u["_id"]
            users.append(u)
        return users
    except Exception as e:
        logger.error(f"Local user search failed: {str(e)}")
        return []

@router.get("")
async def search_all(
    q: str = Query(..., min_length=1, description="Search query string"),
    category: Optional[str] = Query(None, description="Optional category filter: songs, playlists, podcasts, users, albums, artists")
):
    try:
        q = sanitize_text(q, max_length=120)
        if not q:
            return {"success": False, "error": "Search query is required."}
        if category is not None:
            category = sanitize_enum(category, {"songs", "playlists", "podcasts", "users", "albums", "artists"}, "songs")
        tasks = []
        categories_to_run = []

        if not category or category == "songs":
            tasks.append(search_yt_music_songs(q))
            categories_to_run.append("songs")
            
        if not category or category == "playlists":
            tasks.append(search_local_playlists(q))
            categories_to_run.append("playlists")
            
        if not category or category == "podcasts":
            tasks.append(search_podcast_index(q))
            categories_to_run.append("podcasts")
            
        if not category or category == "users":
            tasks.append(search_local_users(q))
            categories_to_run.append("users")
            
        if category == "albums":
            tasks.append(search_yt_music_albums(q))
            categories_to_run.append("albums")
            
        if category == "artists":
            tasks.append(search_yt_music_artists(q))
            categories_to_run.append("artists")

        # Execute searches concurrently
        completed_results = await asyncio.gather(*tasks)
        
        results = {
            "songs": [],
            "playlists": [],
            "podcasts": [],
            "users": [],
            "albums": [],
            "artists": []
        }
        
        for cat, data in zip(categories_to_run, completed_results):
            results[cat] = data

        trending = ["Lofi Beats", "Indian Classical", "Rain Ambient", "Electronic Focus", "Jazz Cafe"]
        
        return {
            "success": True,
            "data": {
                "results": results,
                "trending": trending
            }
        }
        
    except Exception as e:
        logger.error(f"Error in search endpoint: {str(e)}")
        return {
            "success": False,
            "error": f"Search execution failed: {str(e)}"
        }
