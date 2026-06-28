"""
Internal search helpers — used by recommendation and playlist modules to
resolve AI-generated song suggestions to actual videoIds.

These are NOT exposed as HTTP routes. Client-side search happens directly
from the browser via the Invidious public API.
"""

from typing import List, Dict, Any
import asyncio
import logging

from app.services.ytmusic import search_ytmusic_safe

logger = logging.getLogger("strumm-search")

# ---------------------------------------------------------------------------
# Internal helpers (called by recommendation.py and playlist.py)
# ---------------------------------------------------------------------------


async def search_yt_music_songs(q: str) -> List[Dict[str, Any]]:
    """Search songs via ytmusicapi directly (server-side only)."""
    return await asyncio.to_thread(lambda: search_ytmusic_safe(q, filter="songs"))
