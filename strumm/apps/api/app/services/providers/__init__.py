"""
Music Provider — wraps ytmusicapi with caching and health monitoring.

Usage:
    from app.services.providers import get_music_provider

    provider = get_music_provider()
    result = await provider.get_song("dQw4w9WgXcQ")
"""

from app.services.providers.registry import get_music_provider, ProviderRegistry
from app.services.providers.base import (
    MusicProvider,
    ProviderHealth,
    ProviderStatus,
    ProviderMetrics,
    ProviderError,
)
from app.services.providers.ytmusic_provider import YTMusicProvider

__all__ = [
    "get_music_provider",
    "ProviderRegistry",
    "MusicProvider",
    "ProviderHealth",
    "ProviderStatus",
    "ProviderMetrics",
    "ProviderError",
    "YTMusicProvider",
]
