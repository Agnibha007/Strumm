"""
Routes package — FastAPI route handlers organized by domain.
"""

import os

from app.routes.auth import router as auth_router

HOKAS_PROFILE = os.getenv("HOKAS_PROFILE", "").strip().lower() in {"1", "true", "yes", "on"}

if not HOKAS_PROFILE:
    from app.routes.stream import router as stream_router

from app.routes.lyrics import router as lyrics_router
from app.routes.playlist import router as playlist_router
from app.routes.user import router as user_router
from app.routes.podcast import router as podcast_router
from app.routes.recommendation import router as recommendation_router
from app.routes.share import router as share_router
from app.routes.social import router as social_router

__all__ = [
    "auth_router",
    "lyrics_router",
    "playlist_router",
    "user_router",
    "podcast_router",
    "recommendation_router",
    "share_router",
    "social_router",
]

if not HOKAS_PROFILE:
    __all__.append("stream_router")
