from fastapi import APIRouter, Query
from typing import Optional, List, Dict, Any
import asyncio
import time
import logging

from app.database import mongodb as db
from app.services.podcast_index import PodcastIndexNotConfigured, search_podcasts
from app.services.security import escaped_regex, sanitize_enum, sanitize_text
from app.services.cache import (
    cache_search,
    get_cached_search,
    cache_artist,
    get_cached_artist,
    cache_album,
    get_cached_album,
    record_search_latency,
)
from app.services.coalescer import get_coalescer
from app.services.ytmusic import search_ytmusic_safe

logger = logging.getLogger("strumm-search")
router = APIRouter(prefix="/search", tags=["search"])

_coalescer = get_coalescer()

# ---------------------------------------------------------------------------
# Internal helpers — parse raw YTMusic results into Strumm format
# ---------------------------------------------------------------------------


def _parse_song_results(search_results: list) -> list:
    """Parse raw YTMusic song search results into Strumm format."""
    songs = []
    for item in search_results:
        video_id = item.get("videoId")
        if not video_id:
            continue

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
        artist_name = ", ".join(
            [a.get("name", "") for a in artists_list if a.get("name")]
        ) if artists_list else "Unknown Artist"

        thumbnails = item.get("thumbnails", [])
        thumb_url = (
            thumbnails[-1].get("url", "")
            if thumbnails
            else f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
        )

        album_info = item.get("album")
        album_name = album_info.get("name", "") if album_info else ""

        songs.append({
            "videoId": video_id,
            "title": item.get("title", "Untitled Track"),
            "artist": artist_name,
            "thumbnail": thumb_url,
            "duration": duration_sec,
            "metadata": {"album": album_name},
        })
    return songs


def _parse_album_results(search_results: list) -> list:
    """Parse raw YTMusic album search results into Strumm format."""
    albums = []
    for item in search_results:
        browse_id = item.get("browseId")
        if not browse_id:
            continue
        artists_list = item.get("artists", [])
        artist_name = ", ".join(
            [a.get("name", "") for a in artists_list if a.get("name")]
        ) if artists_list else "Unknown Artist"
        thumbnails = item.get("thumbnails", [])
        thumb_url = thumbnails[-1].get("url", "") if thumbnails else ""
        albums.append({
            "id": browse_id,
            "title": item.get("title", "Untitled Album"),
            "artist": artist_name,
            "thumbnail": thumb_url,
            "year": item.get("year", ""),
        })
    return albums


def _parse_artist_results(search_results: list) -> list:
    """Parse raw YTMusic artist search results into Strumm format."""
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
            "thumbnail": thumb_url,
        })
    return artists


# ---------------------------------------------------------------------------
# YTMusic search helpers — with cache + coalescing
# ---------------------------------------------------------------------------


async def search_yt_music_songs(q: str) -> List[Dict[str, Any]]:
    """Search YTMusic songs with in-memory cache and request coalescing."""
    cache_key_str = f"song:{q}"

    cached = get_cached_search(cache_key_str)
    if cached is not None:
        logger.info(f"Search cache HIT for '{q}'")
        return cached

    start = time.monotonic()
    try:
        search_results = await _coalescer.execute(
            key=f"yt:songs:{q}",
            factory=lambda: asyncio.to_thread(search_ytmusic_safe, q, filter="songs"),
            timeout=8.0,
        )
    except Exception as exc:
        logger.warning(
            f"YTMusic song search failed for '{q}': {type(exc).__name__}: {exc!s:.150}"
        )
        return []

    elapsed_ms = (time.monotonic() - start) * 1000
    record_search_latency(elapsed_ms)

    songs = _parse_song_results(search_results or [])
    cache_search(cache_key_str, songs)
    logger.info(f"Search cache MISS for '{q}' — cached {len(songs)} songs ({elapsed_ms:.0f}ms)")
    return songs


async def search_yt_music_albums(q: str) -> List[Dict[str, Any]]:
    """Search YTMusic albums with in-memory cache and request coalescing."""
    cache_key_str = f"album:{q}"

    cached = get_cached_album(cache_key_str)
    if cached is not None:
        logger.info(f"Album cache HIT for '{q}'")
        return cached

    start = time.monotonic()
    try:
        search_results = await _coalescer.execute(
            key=f"yt:albums:{q}",
            factory=lambda: asyncio.to_thread(search_ytmusic_safe, q, filter="albums"),
            timeout=8.0,
        )
    except Exception as exc:
        logger.warning(
            f"YTMusic album search failed for '{q}': {type(exc).__name__}: {exc!s:.150}"
        )
        return []

    elapsed_ms = (time.monotonic() - start) * 1000
    record_search_latency(elapsed_ms)

    albums = _parse_album_results(search_results or [])
    cache_album(cache_key_str, albums)
    logger.info(f"Album cache MISS for '{q}' — cached {len(albums)} albums ({elapsed_ms:.0f}ms)")
    return albums


async def search_yt_music_artists(q: str) -> List[Dict[str, Any]]:
    """Search YTMusic artists with in-memory cache and request coalescing."""
    cache_key_str = f"artist:{q}"

    cached = get_cached_artist(cache_key_str)
    if cached is not None:
        logger.info(f"Artist cache HIT for '{q}'")
        return cached

    start = time.monotonic()
    try:
        search_results = await _coalescer.execute(
            key=f"yt:artists:{q}",
            factory=lambda: asyncio.to_thread(search_ytmusic_safe, q, filter="artists"),
            timeout=8.0,
        )
    except Exception as exc:
        logger.warning(
            f"YTMusic artist search failed for '{q}': {type(exc).__name__}: {exc!s:.150}"
        )
        return []

    elapsed_ms = (time.monotonic() - start) * 1000
    record_search_latency(elapsed_ms)

    artists = _parse_artist_results(search_results or [])
    cache_artist(cache_key_str, artists)
    logger.info(f"Artist cache MISS for '{q}' — cached {len(artists)} artists ({elapsed_ms:.0f}ms)")
    return artists


# ---------------------------------------------------------------------------
# Non-YTMusic search helpers
# ---------------------------------------------------------------------------


async def search_podcast_index(q: str) -> List[Dict[str, Any]]:
    try:
        return await search_podcasts(q, max_results=12)
    except PodcastIndexNotConfigured:
        logger.warning("PodcastIndex credentials are not configured; podcast search returned no external results.")
    except Exception as e:
        logger.error(f"PodcastIndex search failed: {str(e)}")
    return []


async def search_local_playlists(q: str) -> List[Dict[str, Any]]:
    try:
        database = db.get_db()
        regex_query = escaped_regex(q)
        playlist_cursor = database[db.PLAYLISTS].find(
            {"name": regex_query, "visibility": "public"},
            {"name": 1, "description": 1, "followers": 1, "songs": {"$slice": 1}},
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


async def search_local_users(q: str) -> List[Dict[str, Any]]:
    try:
        database = db.get_db()
        regex_query = escaped_regex(q)
        user_cursor = database[db.USERS].find(
            {"displayName": regex_query, "settings.privacy": "public"},
            {"displayName": 1, "username": 1, "avatar": 1, "theme": 1},
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/song/{id}")
async def get_song_by_id(id: str):
    from app.services.ytmusic import call_ytmusic_safe

    try:
        watch = await asyncio.to_thread(
            call_ytmusic_safe, "get_watch_playlist",
            videoId=id, limit=1,
        )
        if not watch or not watch.get("tracks"):
            return {"success": False, "error": "Song not found"}

        track = watch["tracks"][0]
        duration_sec = track.get("length") or 200
        artists_list = track.get("artists", [])
        artist_name = ", ".join(
            [a.get("name", "") for a in artists_list if a.get("name")]
        ) if artists_list else "Unknown Artist"
        thumbnails = track.get("thumbnail", [])
        thumb_url = (
            thumbnails[-1].get("url", "")
            if thumbnails
            else f"https://img.youtube.com/vi/{id}/hqdefault.jpg"
        )
        album_info = track.get("album")
        album_name = album_info.get("name", "") if album_info else ""

        return {
            "success": True,
            "data": {
                "videoId": id,
                "title": track.get("title", "Untitled Track"),
                "artist": artist_name,
                "thumbnail": thumb_url,
                "duration": duration_sec,
                "metadata": {"album": album_name},
            },
        }
    except Exception as e:
        logger.error(f"Error fetching song {id}: {str(e)}")
        return {"success": False, "error": str(e)}


@router.get("")
async def search_all(
    q: str = Query(..., min_length=1, description="Search query string"),
    category: Optional[str] = Query(
        None,
        description="Optional category filter: songs, playlists, podcasts, users, albums, artists",
    ),
):
    try:
        q = sanitize_text(q, max_length=120)
        if not q:
            return {"success": False, "error": "Search query is required."}
        if category is not None:
            category = sanitize_enum(
                category, {"songs", "playlists", "podcasts", "users", "albums", "artists"}, "songs"
            )

        # Check compound cache
        cache_key_str = f"{q}:{category or 'all'}"
        cached = get_cached_search(cache_key_str)
        if cached:
            logger.info(f"Compound search cache HIT for '{cache_key_str}'")
            return {"success": True, "data": cached}

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

        completed_results = await asyncio.gather(*tasks)

        results = {
            "songs": [],
            "playlists": [],
            "podcasts": [],
            "users": [],
            "albums": [],
            "artists": [],
        }
        for cat, data in zip(categories_to_run, completed_results):
            results[cat] = data

        trending = ["Lofi Beats", "Indian Classical", "Rain Ambient", "Electronic Focus", "Jazz Cafe"]

        response_data = {"results": results, "trending": trending}
        cache_search(cache_key_str, response_data)

        return {"success": True, "data": response_data}

    except Exception as e:
        logger.error(f"Error in search endpoint: {str(e)}")
        return {"success": False, "error": f"Search execution failed: {str(e)}"}


async def get_yt_music_album_tracks(browse_id: str) -> Dict[str, Any]:
    from app.services.ytmusic import call_ytmusic_safe

    try:
        album_details = await asyncio.to_thread(call_ytmusic_safe, "get_album", browse_id)
        if not album_details:
            return {"success": False, "error": "Album not found"}

        album_title = album_details.get("title", "Untitled Album")
        artists_list = album_details.get("artists", [])
        album_artist = ", ".join(
            [a.get("name", "") for a in artists_list if a.get("name")]
        ) if artists_list else "Unknown Artist"
        thumbnails = album_details.get("thumbnails", [])
        album_thumb = thumbnails[-1].get("url", "") if thumbnails else ""

        tracks = []
        for item in album_details.get("tracks", []):
            video_id = item.get("videoId")
            if not video_id:
                continue

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

            track_artists_list = item.get("artists", [])
            track_artist = ", ".join(
                [a.get("name", "") for a in track_artists_list if a.get("name")]
            ) if track_artists_list else album_artist
            track_thumbnails = item.get("thumbnails", [])
            track_thumb = track_thumbnails[-1].get("url", "") if track_thumbnails else album_thumb

            tracks.append({
                "videoId": video_id,
                "title": item.get("title", "Untitled Track"),
                "artist": track_artist,
                "thumbnail": track_thumb,
                "duration": duration_sec,
                "metadata": {"album": album_title},
            })

        return {
            "success": True,
            "data": {
                "title": album_title,
                "artist": album_artist,
                "thumbnail": album_thumb,
                "tracks": tracks,
            },
        }
    except Exception as e:
        logger.error(f"Error fetching YTMusic album details: {str(e)}")
        return {"success": False, "error": str(e)}


@router.get("/albums/{browse_id}/tracks")
async def get_album_tracks(browse_id: str):
    return await get_yt_music_album_tracks(browse_id)
