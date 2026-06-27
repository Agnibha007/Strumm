import os
import asyncio
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Path, Query
import httpx
from app.database import mongodb as db
from app.services.security import sanitize_multiline_text, sanitize_text, sanitize_youtube_id
from app.services.cache import cache_lyrics, get_cached_lyrics
import logging
import re

logger = logging.getLogger("strumm-lyrics")
router = APIRouter(prefix="/lyrics", tags=["lyrics"])

LRCLIB_BASE_URL = os.getenv("LRCLIB_BASE_URL", "https://lrclib.net/api")
HTTP_USER_AGENT = os.getenv("HTTP_USER_AGENT", "Strumm/1.0 (https://localhost)")

def has_lrc_timestamps(value: Optional[str]) -> bool:
    return bool(value and "[" in value and "]" in value)

def normalize_match_text(value: str) -> str:
    cleaned = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", value.lower())
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned)
    return " ".join(cleaned.split())

def choose_lrclib_match(matches: list[dict], title: str, artist: str) -> Optional[dict]:
    if not matches:
        return None

    wanted_title = normalize_match_text(title)
    wanted_artist = normalize_match_text(artist)

    def score(match: dict) -> int:
        track = normalize_match_text(str(match.get("trackName") or match.get("name") or ""))
        artist_name = normalize_match_text(str(match.get("artistName") or ""))
        value = 0
        if track == wanted_title:
            value += 10
        elif wanted_title in track or track in wanted_title:
            value += 5
        if artist_name == wanted_artist:
            value += 8
        elif wanted_artist and (wanted_artist in artist_name or artist_name in wanted_artist):
            value += 4
        if match.get("syncedLyrics"):
            value += 3
        return value

    return max(matches, key=score)

async def fetch_lrclib_lyrics(title: str, artist: str, album: Optional[str] = None, duration: Optional[int] = None) -> Optional[dict]:
    params = {
        "track_name": sanitize_text(title, max_length=160),
        "artist_name": sanitize_text(artist, max_length=160),
    }
    if album:
        params["album_name"] = sanitize_text(album, max_length=160)
    if duration:
        params["duration"] = str(duration)

    try:
        async with httpx.AsyncClient(headers={"User-Agent": HTTP_USER_AGENT}, timeout=5.0) as client:
            response = await client.get(
                f"{LRCLIB_BASE_URL}/search",
                params={"track_name": params["track_name"], "artist_name": params["artist_name"]},
            )
            response.raise_for_status()
            data = choose_lrclib_match(response.json(), title, artist)
            if not data:
                return None

            synced = sanitize_multiline_text(data.get("syncedLyrics") or "", max_length=50000)
            plain = sanitize_multiline_text(data.get("plainLyrics") or "", max_length=50000)
            if synced or plain:
                return {
                    "plain": plain,
                    "synced": synced,
                    "source": "lrclib",
                    "isSynced": has_lrc_timestamps(synced),
                }
    except Exception as e:
        logger.warning(f"LRCLIB lookup failed for '{title}' by '{artist}': {type(e).__name__}: {e!r}")
    return None

async def fetch_provider_lyrics(video_id: str) -> Optional[dict]:
    """Fetch lyrics via the active music provider."""
    from app.services.providers import get_music_provider

    try:
        provider = get_music_provider()
        # First, get the watch playlist to find the lyrics browse ID
        watch = await provider.get_watch_playlist(video_id, limit=1)
        if not watch:
            return None

        lyrics_browse_id = watch.get("lyrics")
        if isinstance(lyrics_browse_id, dict):
            lyrics_browse_id = lyrics_browse_id.get("browseId")
        if not isinstance(lyrics_browse_id, str) or not lyrics_browse_id:
            return None

        lyrics = await provider.get_lyrics(lyrics_browse_id)
        plain = sanitize_multiline_text(lyrics.get("lyrics", ""), max_length=50000) if lyrics else ""
        if not plain:
            return None

        return {
            "plain": plain,
            "synced": "",
            "source": "ytmusic",
            "isSynced": False,
        }
    except Exception as e:
        logger.warning(f"Provider lyrics fallback failed for {video_id}: {str(e)}")
    return None

def unavailable_lyrics(title: str, artist: str) -> dict:
    return {
        "plain": f"Lyrics are not available for '{title}' by '{artist}' yet.",
        "synced": "",
        "source": "unavailable",
        "isSynced": False,
    }

@router.get("/{id}")
async def get_lyrics(
    id: str = Path(..., description="The YouTube videoId to get lyrics for"),
    title: Optional[str] = Query(None, description="Optional title hint"),
    artist: Optional[str] = Query(None, description="Optional artist hint")
):
    try:
        id = sanitize_youtube_id(id)
        title = sanitize_text(title, max_length=160) if title else None
        artist = sanitize_text(artist, max_length=160) if artist else None
        database = db.get_db()

        # 1. FIRST: Verify song exists in database (playlists, liked_songs, playback_histories)
        # This ensures we only fetch lyrics for known songs in our database
        song_doc = await database[db.PLAYLISTS].find_one(
            {"songs.videoId": id},
            {"songs.$": 1}
        )
        if song_doc and "songs" in song_doc:
            song_title = song_doc["songs"][0].get("title")
            song_artist = song_doc["songs"][0].get("artist")
        else:
            liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": id})
            if liked_doc:
                song_title = liked_doc["song"].get("title")
                song_artist = liked_doc["song"].get("artist")
            else:
                history_doc = await database[db.PLAYBACK_HISTORIES].find_one({"song.videoId": id})
                if history_doc:
                    song_title = history_doc["song"].get("title")
                    song_artist = history_doc["song"].get("artist")
                else:
                    return {"success": False, "error": "Song not found in database. Lyrics unavailable."}

        # Use provided title/artist if available, fallback to DB values
        if title:
            song_title = title
        if artist:
            song_artist = artist

        if not song_title:
            song_title = "Unknown Song"
        if not song_artist:
            song_artist = "Unknown Artist"

        # 2. Check in-memory cache
        cache_key_str = f"lyrics:{id}"
        cached = get_cached_lyrics(cache_key_str)
        if cached:
            return {"success": True, "data": cached}
        
        # 3. Check MongoDB lyrics cache
        lyrics_cache = await database["lyrics_cache"].find_one({"videoId": id})
        if lyrics_cache and lyrics_cache.get("source") in {"lrclib", "ytmusic"}:
            result = {
                "videoId": id,
                "plain": lyrics_cache.get("plain"),
                "synced": lyrics_cache.get("synced"),
                "source": lyrics_cache.get("source", "cache"),
                "isSynced": bool(lyrics_cache.get("isSynced", has_lrc_timestamps(lyrics_cache.get("synced"))))
            }
            cache_lyrics(cache_key_str, result)
            return {"success": True, "data": result}

        # 4. Fetch from external APIs (lrclib first, then provider fallback)
        lyrics = await fetch_lrclib_lyrics(song_title, song_artist)
        if not lyrics or not lyrics.get("plain") and not lyrics.get("synced"):
            lyrics = await fetch_provider_lyrics(id)
        if not lyrics:
            lyrics = unavailable_lyrics(song_title, song_artist)
        
        # 5. Cache to both in-memory and MongoDB
        result = {
            "videoId": id,
            "plain": lyrics["plain"],
            "synced": lyrics["synced"],
            "source": lyrics["source"],
            "isSynced": lyrics["isSynced"]
        }
        cache_lyrics(cache_key_str, result)

        await database["lyrics_cache"].update_one(
            {"videoId": id},
            {
                "$set": {
                    "videoId": id,
                    "title": song_title,
                    "artist": song_artist,
                    "plain": lyrics["plain"],
                    "synced": lyrics["synced"],
                    "source": lyrics["source"],
                    "isSynced": lyrics["isSynced"],
                    "updatedAt": datetime.utcnow()
                }
            },
            upsert=True
        )

        return {"success": True, "data": result}
    except Exception as e:
        logger.error(f"Error in lyrics resolution for {id}: {str(e)}")
        return {"success": False, "error": f"Failed to retrieve lyrics: {str(e)}"}
