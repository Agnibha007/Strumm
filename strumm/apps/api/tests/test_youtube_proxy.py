"""Tests for the backend YouTube proxy endpoints (app/routes/youtube.py).

These cover:
    * Piped-compatible output shapes (search / playlist / streams / related)
    * graceful degradation when each provider fails
    * configurable PIPED_INSTANCES (never hardcoded-only)

The providers (ytmusicapi, Piped, yt-dlp) are mocked so no network egress
occurs in tests.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.ytfallback import _load_piped_instances


def test_load_piped_instances_defaults(monkeypatch):
    monkeypatch.delenv("PIPED_INSTANCES", raising=False)
    inst = _load_piped_instances()
    assert len(inst) >= 1
    assert all(i.startswith("http") for i in inst)


def test_load_piped_instances_from_env(monkeypatch):
    monkeypatch.setenv("PIPED_INSTANCES", "https://a.example.com ,  https://b.example.com")
    inst = _load_piped_instances()
    assert inst == ["https://a.example.com", "https://b.example.com"]


def test_load_piped_instances_invalid_falls_back_to_defaults(monkeypatch):
    monkeypatch.setenv("PIPED_INSTANCES", "not-a-url,  , foo")
    inst = _load_piped_instances()
    assert len(inst) >= 1
    assert all(i.startswith("http") for i in inst)


# ---------------------------------------------------------------------------
# Shape normalization helpers
# ---------------------------------------------------------------------------


def test_piped_pick_thumb_largest():
    from app.routes.youtube import _piped_pick_thumb

    thumbs = [
        {"url": "small.jpg", "width": 100, "height": 100},
        {"url": "big.jpg", "width": 480, "height": 360},
    ]
    assert _piped_pick_thumb(thumbs, "abc") == "big.jpg"


def test_piped_pick_thumb_falls_back_to_youtube_thumbnail():
    from app.routes.youtube import _piped_pick_thumb

    assert _piped_pick_thumb(None, "abc123") == "https://img.youtube.com/vi/abc123/hqdefault.jpg"


def test_piped_artist_joins_names():
    from app.routes.youtube import _piped_artist

    assert _piped_artist([{"name": "A"}, {"name": "B"}]) == "A, B"
    assert _piped_artist([]) == "Unknown Artist"


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_server_ytmusic_primary(monkeypatch):
    from app.routes import youtube

    def fake_search(q, filter):
        return [{
            "videoId": "dQw4w9WgXcQ",
            "title": "Rick",
            "artists": [{"name": "R"}],
            "thumbnails": [{"url": "t.jpg"}],
            "duration": 210,
        }]

    monkeypatch.setattr("app.services.ytmusic.search_ytmusic_safe", fake_search)
    payload = await youtube._search_server("rick", "song")
    assert payload["items"][0]["type"] == "stream"
    assert payload["items"][0]["url"] == "/watch?v=dQw4w9WgXcQ"


@pytest.mark.asyncio
async def test_search_server_degrades_when_ytmusic_fails(monkeypatch):
    from app.routes import youtube

    def boom(q, filter):
        raise RuntimeError("bot-blocked")

    monkeypatch.setattr("app.services.ytmusic.search_ytmusic_safe", boom)
    monkeypatch.setattr("app.services.ytfallback.search_fallback", lambda q, limit=10: [])
    payload = await youtube._search_server("rick", "song")
    assert payload == {"items": [], "nextpage": ""}


# ---------------------------------------------------------------------------
# Playlist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_playlist_uses_ytmusic_shape(monkeypatch):
    from app.routes import youtube

    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, *a, **k: {
            "title": "My Mix",
            "tracks": [
                {"videoId": "aaa11111111", "title": "One", "artists": [{"name": "A"}], "duration_seconds": 100},
            ],
        } if method == "get_playlist" else None,
    )

    result = await youtube.proxy_playlist("PL123")
    assert result["success"] is True
    data = result["data"]
    assert data["name"] == "My Mix"
    assert data["relatedStreams"][0]["url"] == "/watch?v=aaa11111111"
    assert data["nextpage"] == ""


@pytest.mark.asyncio
async def test_proxy_playlist_returns_empty_on_failure(monkeypatch):
    from app.routes import youtube

    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("unreachable")),
    )
    fake_client = MagicMock()
    fake_client.get = AsyncMock(side_effect=RuntimeError("no network"))
    monkeypatch.setattr(youtube, "get_http_client", lambda: fake_client)

    result = await youtube.proxy_playlist("PL123")
    assert result["success"] is True
    assert result["data"]["relatedStreams"] == []


# ---------------------------------------------------------------------------
# Streams / related
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_streams_includes_direct_audio_and_related(monkeypatch):
    from app.routes import youtube

    monkeypatch.setattr("app.routes.stream.get_direct_audio", AsyncMock(return_value={
        "videoId": "dQw4w9WgXcQ",
        "audioUrl": "https://googlevideo.example/a.m4a",
        "mimeType": "audio/mp4",
        "duration": 200,
    }))

    def fake_watch(videoId=None, limit=None):
        return {"tracks": [{"videoId": "bbb22222222", "title": "Next", "artists": [{"name": "A"}], "length": 180}]}

    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, **k: fake_watch(**k) if method == "get_watch_playlist" else None,
    )

    result = await youtube.proxy_streams("dQw4w9WgXcQ")
    data = result["data"]
    assert data["audioStreams"][0]["url"] == "https://googlevideo.example/a.m4a"
    assert any(r["url"].endswith("bbb22222222") for r in data["relatedStreams"])


@pytest.mark.asyncio
async def test_proxy_streams_degrades_to_empty_when_all_providers_blocked(monkeypatch):
    """When direct-audio AND watch-playlist both fail (e.g. host IP blocked by
    YouTube), the route still returns a well-formed payload with empty arrays
    rather than erroring — the frontend treats that as "no data" and moves on.
    """
    from app.routes import youtube

    monkeypatch.setattr("app.routes.stream.get_direct_audio", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, **k: None,
    )
    fake_client = MagicMock()
    fake_client.get = AsyncMock(side_effect=RuntimeError("piped unreachable"))
    monkeypatch.setattr(youtube, "get_http_client", lambda: fake_client)

    result = await youtube.proxy_streams("dQw4w9WgXcQ")
    assert result["success"] is True
    data = result["data"]
    assert data["audioStreams"] == []
    assert data["videoStreams"] == []
    assert data["relatedStreams"] == []


@pytest.mark.asyncio
async def test_proxy_related_returns_songs(monkeypatch):
    from app.routes import youtube

    def fake_watch(videoId=None, limit=None):
        return {"tracks": [{"videoId": "bbb22222222", "title": "Next", "artists": [{"name": "A"}], "length": 180}]}

    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, **k: fake_watch(**k) if method == "get_watch_playlist" else None,
    )

    result = await youtube.proxy_related("dQw4w9WgXcQ", exclude="")
    assert result["data"]["songs"][0]["videoId"] == "bbb22222222"


@pytest.mark.asyncio
async def test_proxy_related_excludes_and_returns_empty_on_failure(monkeypatch):
    from app.routes import youtube

    def fake_watch(videoId=None, limit=None):
        return {"tracks": [{"videoId": "bbb22222222", "title": "Next", "artists": [{"name": "A"}], "length": 180}]}

    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, **k: fake_watch(**k) if method == "get_watch_playlist" else None,
    )
    fake_client = MagicMock()
    fake_client.get = AsyncMock(side_effect=RuntimeError("no network"))
    monkeypatch.setattr(youtube, "get_http_client", lambda: fake_client)

    result = await youtube.proxy_related("dQw4w9WgXcQ", exclude="bbb22222222")
    assert result["data"]["songs"] == []