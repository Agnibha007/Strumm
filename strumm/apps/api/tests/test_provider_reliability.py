"""
Provider-reliability tests.

Covers the production findings:
  * Piped instances that return 403/429/5xx/526/timeout rotate to the next
    healthy instance; known-bad instances enter cooldown; success resets them
    and a recently-successful instance is preferred.
  * ``/yt/streams`` never returns an unusable fake success, caches usable
    resolutions conservatively, and does not trust expired cache entries.
  * YTMusic failed reachability is cached and is not re-probed on every call.
  * yt-dlp host-block failures are fast-failed and skipped for a TTL.
  * Sensitive query params (Google id_token etc.) never reach logs or Sentry.
  * The disk warning is deployment-agnostic (no Render claim on HF).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_provider_state():
    from app.services.piped import reset_health
    from app.services.cache import _stream_cache
    reset_health()
    _stream_cache.clear()
    yield
    reset_health()
    _stream_cache.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status: int, payload=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = payload or {}
    return r


def _make_async_client(per_url):
    """Fake httpx client: ``per_url(url_prefix) -> resp | raises``."""
    calls: list[str] = []

    async def get(url, **kwargs):
        calls.append(url)
        handler = per_url(url)
        if isinstance(handler, BaseException):
            raise handler
        return handler

    client = MagicMock()
    client.get = AsyncMock(side_effect=get)
    return client, calls


def _install_async_client(monkeypatch, per_url):
    client, calls = _make_async_client(per_url)
    monkeypatch.setattr("app.services.piped._async_client", lambda: client)
    return calls


STREAM_OK = {
    "title": "T",
    "audioStreams": [{"url": "https://inst.example/a.m4a", "mimeType": "audio/mp4", "bitrate": 128}],
    "videoStreams": [],
    "relatedStreams": [],
}


# ---------------------------------------------------------------------------
# 1-4. Rotation on 500 / 403 / 526 / timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_piped_async_rotates_on_500(monkeypatch):
    import app.services.piped as p

    calls = _install_async_client(
        monkeypatch,
        lambda url: (
            _resp(500)
            if url.startswith(p.PIPED_INSTANCES[0])
            else _resp(200, STREAM_OK)
        ),
    )
    found = await p.piped_fetch_json_async(
        "/streams/abc12345678", require_keys=("audioStreams", "videoStreams")
    )
    assert found is not None
    base, payload = found
    assert base == p.PIPED_INSTANCES[1]
    assert payload["audioStreams"][0]["url"].startswith("https://inst.example/")


@pytest.mark.asyncio
async def test_piped_async_rotates_on_403(monkeypatch):
    import app.services.piped as p

    _install_async_client(
        monkeypatch,
        lambda url: (
            _resp(403)
            if url.startswith(p.PIPED_INSTANCES[0])
            else _resp(200, STREAM_OK)
        ),
    )
    found = await p.piped_fetch_json_async("/streams/abc12345678")
    assert found is not None
    assert found[0] == p.PIPED_INSTANCES[1]


@pytest.mark.asyncio
async def test_piped_async_rotates_on_526(monkeypatch):
    import app.services.piped as p

    _install_async_client(
        monkeypatch,
        lambda url: (
            _resp(526)
            if url.startswith(p.PIPED_INSTANCES[0])
            else _resp(200, STREAM_OK)
        ),
    )
    found = await p.piped_fetch_json_async("/streams/abc12345678")
    assert found is not None
    assert found[0] == p.PIPED_INSTANCES[1]


@pytest.mark.asyncio
async def test_piped_async_rotates_on_timeout(monkeypatch):
    import app.services.piped as p

    _install_async_client(
        monkeypatch,
        lambda url: (
            TimeoutError("timed out")
            if url.startswith(p.PIPED_INSTANCES[0])
            else _resp(200, STREAM_OK)
        ),
    )
    found = await p.piped_fetch_json_async("/streams/abc12345678")
    assert found is not None
    assert found[0] == p.PIPED_INSTANCES[1]


# ---------------------------------------------------------------------------
# 5. Success stops unnecessary attempts (sync path is sequential)
# ---------------------------------------------------------------------------


def test_piped_sync_success_stops_additional_attempts(monkeypatch):
    import app.services.piped as p

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _resp(200, {"items": [{"url": "/watch?v=abc12345678", "title": "t"}]})

    monkeypatch.setattr("app.services.piped._attempt_sync", lambda *a, **k: (fake_get(a[0], **k)).json() if False else None)
    # simpler: patch the transport directly
    with patch("app.services.piped._attempt_sync") as attempt:
        attempt.return_value = {"items": [{"url": "/watch?v=abc12345678", "title": "t"}]}
        found = p.piped_fetch_json_sync("/search", require_keys=("items",))
    assert found is not None
    assert found[0] == p.PIPED_INSTANCES[0]
    # only ONE attempt — the successful instance stopped the rest
    attempt.assert_called_once()
    assert p.PIPED_INSTANCES[0] in attempt.call_args.args[0]


# ---------------------------------------------------------------------------
# 6-7. Cooldown / recovery
# ---------------------------------------------------------------------------


def test_unhealthy_instance_enters_cooldown(monkeypatch):
    from app.services.piped import health, PIPED_INSTANCES

    health.record_failure(PIPED_INSTANCES[0], "HTTP 500")
    assert PIPED_INSTANCES[0] not in health.ordered_healthy()
    snap = health.snapshot()[PIPED_INSTANCES[0]]
    assert snap["failures"] >= 1
    assert snap["in_cooldown"] is True
    # the other instances remain available
    assert PIPED_INSTANCES[1] in health.ordered_healthy()


def test_successful_instance_exits_cooldown(monkeypatch):
    from app.services.piped import health, PIPED_INSTANCES

    health.record_failure(PIPED_INSTANCES[0], "HTTP 500")
    assert PIPED_INSTANCES[0] not in health.ordered_healthy()

    health.record_success(PIPED_INSTANCES[0])
    ordered = health.ordered_healthy()
    assert PIPED_INSTANCES[0] in ordered
    assert ordered[0] == PIPED_INSTANCES[0]  # most-recently-successful first


def test_prefers_recently_successful_instance(monkeypatch):
    from app.services.piped import health, PIPED_INSTANCES

    health.record_success(PIPED_INSTANCES[2])
    ordered = health.ordered_healthy()
    assert ordered[0] == PIPED_INSTANCES[2]
    assert ordered[1] == PIPED_INSTANCES[0]  # config order among fresh instances


# ---------------------------------------------------------------------------
# 8-9. /yt/streams: all-fail and budget-exhaustion never fake a success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_streams_all_providers_fail_returns_unavailable(monkeypatch):
    from app.routes import youtube

    monkeypatch.setattr("app.routes.stream.get_direct_audio", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe", lambda method, **k: None
    )
    _install_async_client(monkeypatch, lambda url: _resp(500))

    result = await youtube.proxy_streams("aaa11111111")
    assert result["success"] is False
    assert result["data"]["streamStatus"] == "unavailable"
    assert result["data"]["audioStreams"] == []
    assert result["data"]["videoStreams"] == []


@pytest.mark.asyncio
async def test_streams_budget_exhaustion_does_not_fake_success(monkeypatch):
    from app.routes import youtube

    async def slow_direct(vid):
        import asyncio
        await asyncio.sleep(5)
        return {"videoId": vid, "audioUrl": "https://slow.example/a.m4a"}

    monkeypatch.setattr("app.routes.stream.get_direct_audio", AsyncMock(side_effect=slow_direct))
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe", lambda method, **k: None
    )
    _install_async_client(monkeypatch, lambda url: _resp(200, STREAM_OK))
    # Shrink the budget to milliseconds so the route times out before any
    # provider can return.
    monkeypatch.setattr(youtube, "STREAMS_BUDGET", 0.001)

    result = await youtube.proxy_streams("aaa11111111")
    # Budget exhausted + nothing usable -> explicit failure, NOT a 200-success
    # masquerading as playable data.
    assert result["success"] is False
    assert result["data"]["streamStatus"] == "unavailable"


@pytest.mark.asyncio
async def test_streams_metadata_only_is_a_truthful_success(monkeypatch):
    """Related tracks (from ytmusic) with no direct URL -> metadata_only, not
    playable, and not unavailable — the UI can still use the metadata."""
    from app.routes import youtube

    monkeypatch.setattr("app.routes.stream.get_direct_audio", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe",
        lambda method, **k: {
            "tracks": [{"videoId": "bbb22222222", "title": "Next", "artists": [{"name": "A"}], "length": 180}]
        } if method == "get_watch_playlist" else None,
    )
    _install_async_client(monkeypatch, lambda url: _resp(200, STREAM_OK))

    result = await youtube.proxy_streams("ccc33333333")
    assert result["success"] is True
    assert result["data"]["streamStatus"] == "metadata_only"
    assert result["data"]["relatedStreams"]


# ---------------------------------------------------------------------------
# 10-11. Cache reuse + expiry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_streams_cached_resolution_is_reused(monkeypatch):
    from app.routes import youtube
    from app.services.cache import _stream_cache

    direct = AsyncMock(return_value={
        "videoId": "ddd44444444",
        "audioUrl": "https://googlevideo.example/a.m4a",
        "mimeType": "audio/mp4",
        "duration": 200,
    })
    monkeypatch.setattr("app.routes.stream.get_direct_audio", direct)
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe", lambda method, **k: None
    )
    _install_async_client(monkeypatch, lambda url: _resp(200, STREAM_OK))

    first = await youtube.proxy_streams("ddd44444444")
    assert first["success"] is True
    assert first["data"]["streamStatus"] == "playable"
    assert direct.await_count == 1

    # Second identical request must come from the cache — no provider calls.
    second = await youtube.proxy_streams("ddd44444444")
    assert second["data"]["streamStatus"] == "playable"
    assert direct.await_count == 1
    assert _stream_cache.get("ytstreams:ddd44444444") is not None


@pytest.mark.asyncio
async def test_streams_expired_cache_is_not_trusted(monkeypatch):
    from app.routes import youtube
    from app.services.cache import _stream_cache

    # Seed a cache entry that is ALREADY expired.
    _stream_cache.set("ytstreams:eee55555555", {"title": "stale"}, ttl=-1)

    direct = AsyncMock(return_value=None)
    monkeypatch.setattr("app.routes.stream.get_direct_audio", direct)
    monkeypatch.setattr(
        "app.services.ytmusic.call_ytmusic_safe", lambda method, **k: None
    )
    _install_async_client(monkeypatch, lambda url: _resp(500))

    result = await youtube.proxy_streams("eee55555555")
    # The stale entry was ignored and providers re-ran (all failed here).
    assert result["success"] is False
    assert result["data"]["streamStatus"] == "unavailable"


# ---------------------------------------------------------------------------
# 12-13. YTMusic reachability caching
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_ytmusic_manager():
    import app.services.ytmusic as yt
    mgr = yt._manager
    old = (mgr._last_reachability_check, mgr._reachability_cached, mgr._reachability_probed)
    mgr._last_reachability_check = 0.0
    mgr._reachability_cached = None
    mgr._reachability_probed = False
    yield mgr
    (mgr._last_reachability_check, mgr._reachability_cached, mgr._reachability_probed) = old


def _probe_failure(label, url, timeout):
    return {"label": label, "url": url, "connect_ok": False, "error": "TimeoutError: timed out",
            "status_code": None, "html_title": None, "content_type": None}


@pytest.mark.asyncio
async def test_ytmusic_failed_reachability_is_cached(monkeypatch, fresh_ytmusic_manager):
    import app.services.ytmusic as yt
    mgr = fresh_ytmusic_manager

    calls = {"n": 0}

    def fake_probe(label, url, timeout):
        calls["n"] += 1
        return _probe_failure(label, url, timeout)

    monkeypatch.setattr(yt.YTMusicManager, "_probe_url", staticmethod(fake_probe))

    assert mgr._check_reachability() is False
    # second call within the TTL must NOT re-probe
    assert mgr._check_reachability() is False
    assert calls["n"] == 1
    assert mgr._reachability_cached is False


@pytest.mark.asyncio
async def test_ytmusic_success_clears_failure_state(monkeypatch, fresh_ytmusic_manager):
    import app.services.ytmusic as yt
    mgr = fresh_ytmusic_manager

    state = {"fail": True}

    def fake_probe(label, url, timeout):
        if state["fail"]:
            return _probe_failure(label, url, timeout)
        return {"label": label, "url": url, "connect_ok": True, "error": None,
                "status_code": 200, "html_title": "YouTube Music", "content_type": "text/html"}

    monkeypatch.setattr(yt.YTMusicManager, "_probe_url", staticmethod(fake_probe))

    assert mgr._check_reachability() is False
    # Once the host recovers (cache expired), a fresh probe succeeds.
    mgr._last_reachability_check = 0.0
    state["fail"] = False
    assert mgr._check_reachability() is True
    assert mgr._reachability_cached is True


# ---------------------------------------------------------------------------
# 14. yt-dlp host-block fast-fail
# ---------------------------------------------------------------------------


async def test_ytdlp_blocked_fast_fail_skips_extraction(monkeypatch):
    from app.routes import stream as stream_mod
    from app.services.cache import _stream_cache

    _stream_cache.clear()
    stream_mod._reset_ytdlp_block()

    fallback = {"videoId": "fff66666666", "audioUrl": "https://piped.example/a.m4a", "mimeType": "audio/mp4"}
    monkeypatch.setattr(stream_mod, "_run_piped_extract", lambda vid: fallback)

    def boom(vid):
        raise RuntimeError("Unable to download API page: EOF occurred in violation of protocol")

    # First call: yt-dlp fails with a host-level block -> falls through to Piped
    # AND trips the global fast-fail.
    with patch("app.routes.stream._run_ytdlp_extract", side_effect=boom) as extract:
        result = await stream_mod.get_direct_audio("fff66666666")
    assert result["audioUrl"] == "https://piped.example/a.m4a"
    assert extract.call_count == 1
    assert stream_mod._ytdlp_blocked() is True

    # Second call: yt-dlp is skipped entirely; Piped serves it.
    with patch("app.routes.stream._run_ytdlp_extract", side_effect=AssertionError("should not be called")) as extract2:
        result2 = await stream_mod.get_direct_audio("fff66666666")
    assert result2["audioUrl"] == "https://piped.example/a.m4a"
    extract2.assert_not_called()

    stream_mod._reset_ytdlp_block()
    _stream_cache.clear()


async def test_ytdlp_per_video_failure_does_not_block_host(monkeypatch):
    from app.routes import stream as stream_mod

    stream_mod._reset_ytdlp_block()
    monkeypatch.setattr(stream_mod, "_run_piped_extract", lambda vid: None)

    def per_video(vid):
        raise RuntimeError("Video unavailable")

    with patch("app.routes.stream._run_ytdlp_extract", side_effect=per_video):
        result = await stream_mod.get_direct_audio("ggg77777777")
    assert result is None
    assert stream_mod._ytdlp_blocked() is False  # per-video, not host-wide

    stream_mod._reset_ytdlp_block()


# ---------------------------------------------------------------------------
# 15. Sensitive query params never reach logs / Sentry breadcrumbs
# ---------------------------------------------------------------------------


def test_redact_sensitive_masks_id_token_and_credentials():
    from app.services.log_redaction import redact_sensitive

    url = "https://oauth2.googleapis.com/tokeninfo?id_token=eyJhbGciOi.abc.def&foo=1"
    out = redact_sensitive(url)
    assert "eyJhbGciOi" not in out
    assert "id_token=[REDACTED]" in out
    assert "foo=1" in out  # non-sensitive params untouched

    out2 = redact_sensitive("https://x.com/callback?code=SECRETCODE&state=abc")
    assert "SECRETCODE" not in out2
    assert "code=[REDACTED]" in out2

    out3 = redact_sensitive("GET https://x.com?access_token=tok123&refresh_token=r456")
    assert "tok123" not in out3 and "r456" not in out3
    assert "access_token=[REDACTED]" in out3 and "refresh_token=[REDACTED]" in out3


def test_log_filter_redacts_sensitive_query_params(caplog):
    from app.services.log_redaction import SensitiveQueryFilter, install_log_redaction

    install_log_redaction()  # idempotent
    logger = logging.getLogger("test.redaction.leak")
    if not any(isinstance(f, SensitiveQueryFilter) for f in logger.filters):
        logger.addFilter(SensitiveQueryFilter())

    with caplog.at_level(logging.DEBUG, logger="test.redaction.leak"):
        logger.debug(
            "HTTP Request: GET https://oauth2.googleapis.com/tokeninfo?id_token=eyJTOPSECRETpart"
        )
    assert "eyJTOPSECRETpart" not in caplog.text
    assert "id_token=[REDACTED]" in caplog.text


def test_log_filter_redacts_httpx_arg_tuple(caplog):
    """httpx logs formatted strings where the URL is passed as record.args.
    Verify args tuples/dicts are also redacted so no token leaks."""
    from app.services.log_redaction import SensitiveQueryFilter, install_log_redaction

    install_log_redaction()
    logger = logging.getLogger("test.redaction.args")
    if not any(isinstance(f, SensitiveQueryFilter) for f in logger.filters):
        logger.addFilter(SensitiveQueryFilter())

    with caplog.at_level(logging.DEBUG, logger="test.redaction.args"):
        logger.debug(
            "HTTP Request: %s %s \"%s %d %s\"",
            "GET",
            "https://oauth2.googleapis.com/tokeninfo?id_token=eyJARGSSECRETpart",
            "HTTP/1.1",
            200,
            "OK",
        )
    assert "eyJARGSSECRETpart" not in caplog.text
    assert "id_token=[REDACTED]" in caplog.text


def test_sentry_breadcrumb_redacts_url_and_message():
    from app.services.log_redaction import redact_sentry_breadcrumb

    crumb = {
        "message": "GET https://oauth2.googleapis.com/tokeninfo?id_token=eyJLEAK",
        "data": {"url": "https://oauth2.googleapis.com/tokeninfo?id_token=eyJLEAK2"},
    }
    out = redact_sentry_breadcrumb(crumb, {})
    assert "eyJLEAK" not in out["message"]
    assert "eyJLEAK2" not in out["data"]["url"]
    assert "id_token=[REDACTED]" in out["message"]
    assert "id_token=[REDACTED]" in out["data"]["url"]


# ---------------------------------------------------------------------------
# 16. Disk warning is deployment-agnostic
# ---------------------------------------------------------------------------


def test_disk_warning_does_not_claim_render_on_hf(monkeypatch, caplog):
    from app import main as main_mod

    monkeypatch.setattr(main_mod.shutil, "disk_usage", lambda _: (512 * 1024 * 1024, 460 * 1024 * 1024, 52 * 1024 * 1024))
    monkeypatch.setenv("SPACE_ID", "agnibha07/strumm")
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setattr(main_mod, "_on_render", lambda: False)
    monkeypatch.setattr(main_mod, "_on_hf_spaces", lambda: True)

    with caplog.at_level(logging.WARNING, logger="strumm-api"):
        main_mod._check_disk_usage()
    assert "DISK USAGE WARNING" in caplog.text
    assert "Render free tier" not in caplog.text
    assert "Hugging Face Spaces" in caplog.text


def test_disk_warning_mentions_render_only_on_render(monkeypatch, caplog):
    from app import main as main_mod

    monkeypatch.setattr(main_mod.shutil, "disk_usage", lambda _: (512 * 1024 * 1024, 460 * 1024 * 1024, 52 * 1024 * 1024))
    monkeypatch.setattr(main_mod, "_on_render", lambda: True)
    monkeypatch.setattr(main_mod, "_on_hf_spaces", lambda: False)

    with caplog.at_level(logging.WARNING, logger="strumm-api"):
        main_mod._check_disk_usage()
    assert "DISK USAGE WARNING" in caplog.text
    assert "Render free tier" in caplog.text