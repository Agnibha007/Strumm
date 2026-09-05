"""Tests for the direct-audio / background-playback resolver."""

from unittest.mock import AsyncMock, patch

import pytest

from app.routes.stream import (
    _audio_mime,
    _pick_best_audio,
    get_direct_audio,
)


@pytest.fixture(autouse=True)
def _reset_piped_health():
    """Each test starts with a clean Piped circuit-breaker state (tests that
    fail an instance into cooldown must not leak into later tests)."""
    from app.services.piped import reset_health
    reset_health()
    yield
    reset_health()


def _info_with_formats(*formats):
    return {"title": "Test", "formats": list(formats)}


def _fmt(url, *, audio_only=True, ext="m4a", tbr=128):
    return {
        "url": url,
        "ext": ext,
        "vcodec": "none" if audio_only else "avc1.64001f",
        "acodec": "mp4a.40.2",
        "tbr": tbr,
    }


def test_pick_best_audio_prefers_info_url():
    assert _pick_best_audio({"url": "https://example/direct.m4a"}) == "https://example/direct.m4a"
    assert _pick_best_audio({"url": ""}) is None


def test_pick_best_audio_scans_formats_audio_only_m4a():
    info = _info_with_formats(
        _fmt("https://example/video.mp4", audio_only=False, ext="mp4", tbr=12000),
        _fmt("https://example/audio.m4a", audio_only=True, ext="m4a", tbr=128),
    )
    assert _pick_best_audio(info) == "https://example/audio.m4a"


def test_pick_best_audio_falls_back_to_combined():
    info = _info_with_formats(
        _fmt("https://example/video.mp4", audio_only=False, ext="mp4", tbr=8000)
    )
    assert _pick_best_audio(info) == "https://example/video.mp4"


def test_pick_best_audio_uses_manifest_url():
    info = _info_with_formats(
        {"ext": "m4a", "vcodec": "none", "manifest_url": "https://example/hls.m3u8"}
    )
    assert _pick_best_audio(info) == "https://example/hls.m3u8"


def test_pick_best_audio_empty_info():
    assert _pick_best_audio(None) is None
    assert _pick_best_audio({}) is None
    assert _pick_best_audio(_info_with_formats(_fmt("", tbr=0))) is None


@pytest.mark.parametrize(
    ("ext", "expected"),
    [
        ("m4a", "audio/mp4"),
        ("mp4", "audio/mp4"),
        ("webm", "audio/webm"),
        ("opus", "audio/webm"),
        ("ogg", "audio/ogg"),
        ("aac", "audio/aac"),
        ("", "audio/mp4"),
    ],
)
def test_audio_mime(ext, expected):
    assert _audio_mime(ext) == expected


async def test_get_direct_audio_returns_none_when_extract_fails():
    with patch("app.routes.stream._run_ytdlp_extract", side_effect=RuntimeError("blocked")), patch(
        "app.routes.stream._run_piped_extract", return_value=None
    ):
        assert await get_direct_audio("videofail01") is None


async def test_get_direct_audio_falls_back_to_piped():
    fallback = {
        "videoId": "videofb01",
        "audioUrl": "https://piped.example/audio.m4a",
        "mimeType": "audio/mp4",
        "title": "Fallback",
        "duration": 200,
    }
    with patch("app.routes.stream._run_ytdlp_extract", side_effect=RuntimeError("blocked")), patch(
        "app.routes.stream._run_piped_extract", return_value=fallback
    ):
        result = await get_direct_audio("videofb01")
    assert result is not None
    assert result["audioUrl"] == "https://piped.example/audio.m4a"
    assert result["mimeType"] == "audio/mp4"


async def test_get_direct_audio_prefers_ytdlp_over_piped():
    fake = {
        "title": "Song",
        "duration": 247,
        "ext": "m4a",
        "url": "https://googlevideo.example/stream.m4a",
    }
    fallback = {"audioUrl": "https://piped.example/audio.m4a"}
    with patch("app.routes.stream._run_ytdlp_extract", return_value=fake), patch(
        "app.routes.stream._run_piped_extract", return_value=fallback
    ) as mock_piped:
        result = await get_direct_audio("videopref01")
    assert result["audioUrl"] == "https://googlevideo.example/stream.m4a"
    mock_piped.assert_not_called()


def test_run_piped_extract_skips_odycdn_and_prefers_videoplayback():
    from app.routes.stream import _run_piped_extract

    payload = {
        "title": "T",
        "duration": 100,
        "audioStreams": [],
        "videoStreams": [
            {"url": "https://player.odycdn.com/v6/streams/abc.mp4", "mimeType": "video/mp4", "videoOnly": False, "bitrate": 0},
            {"url": "https://proxy.piped.example/videoplayback?itag=18", "mimeType": "video/mp4", "videoOnly": False, "bitrate": 0},
            {"url": "https://proxy.piped.example/videoplayback?itag=22", "mimeType": "video/mp4", "videoOnly": True, "bitrate": 0},
            {"url": "https://example/hls.m3u8", "mimeType": "application/x-mpegurl", "videoOnly": False, "bitrate": 0},
        ],
    }
    import requests

    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = payload
        from app.services.ytfallback import PIPED_INSTANCES

        result = _run_piped_extract("videopath01")

    assert result is not None
    assert result["audioUrl"] == "https://proxy.piped.example/videoplayback?itag=18"
    assert result["mimeType"] == "audio/mp4"
    mock_get.assert_called_once()
    # First call targets the first Piped instance.
    assert PIPED_INSTANCES[0] in mock_get.call_args.args[0]


async def test_get_direct_audio_extracts_and_caches():
    fake = {
        "title": "Song",
        "duration": 247,
        "ext": "m4a",
        "url": "https://googlevideo.example/stream.m4a",
    }
    extractor = AsyncMock()
    extractor.return_value = fake
    from app.services.cache import _stream_cache

    _stream_cache.clear()

    with patch("app.routes.stream._run_ytdlp_extract", return_value=fake):
        first = await get_direct_audio("videocache01")
        assert first is not None
        assert first["audioUrl"] == "https://googlevideo.example/stream.m4a"
        assert first["mimeType"] == "audio/mp4"

    # Second call must come from the cache — extractor should not run again.
    with patch("app.routes.stream._run_ytdlp_extract", side_effect=fake) as mock_extract:
        second = await get_direct_audio("videocache01")
    assert second == first
    mock_extract.assert_not_called()