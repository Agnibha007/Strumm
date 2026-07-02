"""
Services package — shared business logic, external API clients, and utilities.
"""

from app.services.cache import (
    cache_search, cache_artist, cache_album, cache_lyrics,
    cache_recommendation, cache_podcast, cache_stream,
    get_cached_search, get_cached_artist, get_cached_album,
    get_cached_lyrics, get_cached_recommendation, get_cached_podcast,
    get_cached_stream, cache_key, clear_all_caches,
    record_search_latency, get_latency_snapshot,
)
from app.services.coalescer import get_coalescer
from app.services.normalizer import (
    canonical_string, canonical_song_key, canonical_artist,
    normalize_artist, are_same_artist, generate_canonical_for_song,
    classify_genre,
)
from app.services.security import (
    sanitize_text, sanitize_multiline_text, sanitize_username,
    sanitize_youtube_id, sanitize_enum, sanitize_positive_int,
    escaped_regex, parse_object_id, assert_public_http_url,
    require_admin,
)
from app.services.auth_utils import (
    create_access_token, decode_access_token,
    hash_password, verify_password, hash_otp,
)
from app.services.recommendation_engine import get_recommendation_engine
from app.services.song_lookup import find_song_in_db, find_song_title_artist

__all__ = [
    # Cache
    "cache_search", "cache_artist", "cache_album", "cache_lyrics",
    "cache_recommendation", "cache_podcast", "cache_stream",
    "get_cached_search", "get_cached_artist", "get_cached_album",
    "get_cached_lyrics", "get_cached_recommendation", "get_cached_podcast",
    "get_cached_stream", "cache_key", "clear_all_caches",
    "record_search_latency", "get_latency_snapshot",
    # Coalescer
    "get_coalescer",
    # Normalizer
    "canonical_string", "canonical_song_key", "canonical_artist",
    "normalize_artist", "are_same_artist", "generate_canonical_for_song",
    "classify_genre",
    # Security
    "sanitize_text", "sanitize_multiline_text", "sanitize_username",
    "sanitize_youtube_id", "sanitize_enum", "sanitize_positive_int",
    "escaped_regex", "parse_object_id", "assert_public_http_url",
    "require_admin",
    # Auth
    "create_access_token", "decode_access_token",
    "hash_password", "verify_password", "hash_otp",
    # Recommendations
    "get_recommendation_engine",
    # Song lookup
    "find_song_in_db", "find_song_title_artist",
]
