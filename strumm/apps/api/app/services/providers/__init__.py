"""
Music Provider Architecture — provider-based YouTube metadata layer.

Provides a uniform interface for fetching music metadata from multiple
backends (InnerTube, ytmusicapi, etc.) with automatic health monitoring,
caching, request coalescing, and transparent failover.

Usage:
    from app.services.providers import get_music_provider

    provider = get_music_provider()
    results = await provider.search("lofi beats", filter="songs")
"""

from app.services.providers.registry import get_music_provider, ProviderRegistry
from app.services.providers.base import (
    MusicProvider,
    ProviderHealth,
    ProviderStatus,
    ProviderMetrics,
    ProviderError,
)
from app.services.providers.youtube_data_provider import YouTubeDataAPIProvider
from app.services.providers.innertube_provider import InnerTubeProvider
from app.services.providers.piped_provider import PipedProvider
from app.services.providers.ytmusic_provider import YTMusicProvider

__all__ = [
    "get_music_provider",
    "ProviderRegistry",
    "MusicProvider",
    "ProviderHealth",
    "ProviderStatus",
    "ProviderMetrics",
    "ProviderError",
    "YouTubeDataAPIProvider",
    "InnerTubeProvider",
    "PipedProvider",
    "YTMusicProvider",
]
