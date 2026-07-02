"""
Shared song database lookup utilities.

Consolidates the common pattern of checking playlists → liked_songs → history
that was duplicated across stream.py, lyrics.py, share.py, and recommendation.py.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.database import mongodb as db
logger = logging.getLogger("strumm-song-lookup")


async def find_song_in_db(video_id: str) -> Optional[dict]:
    """
    Search for a song record across all database collections.

    Lookup order:
      1. Playlists (embedded song documents)
      2. Liked songs
      3. Playback history

    Returns the raw song dict (with keys like videoId, title, artist, thumbnail,
    duration) or None if not found in any collection.
    """
    database = db.get_db()

    # 1. Check playlists
    playlist_doc = await database[db.PLAYLISTS].find_one(
        {"songs.videoId": video_id},
        {"songs.$": 1},
    )
    if playlist_doc and "songs" in playlist_doc and len(playlist_doc["songs"]) > 0:
        return playlist_doc["songs"][0]

    # 2. Check liked songs
    liked_doc = await database[db.LIKED_SONGS].find_one({"song.videoId": video_id})
    if liked_doc:
        return liked_doc["song"]

    # 3. Check playback history
    history_doc = await database[db.PLAYBACK_HISTORIES].find_one({"song.videoId": video_id})
    if history_doc:
        return history_doc["song"]

    return None


async def find_song_title_artist(video_id: str) -> tuple[str, str]:
    """
    Find a song's title and artist across all DB collections.

    Returns (title, artist) or ("Unknown Song", "Unknown Artist") if not found.
    """
    song = await find_song_in_db(video_id)
    if song:
        return (
            song.get("title") or "Unknown Song",
            song.get("artist") or "Unknown Artist",
        )
    return "Unknown Song", "Unknown Artist"
