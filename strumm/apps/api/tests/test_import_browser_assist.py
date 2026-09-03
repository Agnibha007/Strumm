"""
Tests for the browser-assisted import flow (Playlist Import v2).

Covers:
  * ``_search_candidates`` / ``_match_track`` preferring injected (browser)
    candidates over the server-side provider chain
  * ``_run_import_pipeline`` honouring a ``resolve_map`` (track index ->
    browser candidates) with per-track server fallback
  * ``POST /playlists/import/parse`` returning tracks WITHOUT resolving
  * ``POST /playlists/import/resolve`` accepting browser candidates keyed
    by track index (sanitising malformed entries) and matching them

The browser candidates use the exact shape the web app's
BrowserYouTubeMusicResolver emits: ``videoId``/``title``/``artists``/
``artist``/``duration`` ("m:ss")/``duration_seconds``/``thumbnails``.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.routes.playlist import (
    ImportContext,
    _match_track,
    _run_import_pipeline,
    _search_candidates,
    STATUS_MATCHED,
    STATUS_NOT_FOUND,
    STATUS_UNREACHABLE,
    HIGH_CONFIDENCE_THRESHOLD,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def make_outcome(status="ok", results=None, reason="ok"):
    found = status == "ok" and bool(results)
    return MagicMock(found=found, status=status, reason=reason, results=results or [])


def fake_fallback(*results):
    """Build a ``search_fallback`` dispatcher returning a list of raw
    candidates per query (browser-only policy: import fallbacks go through
    yt-dlp/public providers, never ytmusicapi). Mirrors
    ``app.services.ytfallback.search_fallback``'s list-return contract."""
    def _fallback(query, *, limit=10):
        hits = []
        for cond, items in results:
            if callable(cond):
                if cond(query):
                    hits = items
                    break
            elif cond in query.lower():
                hits = items
                break
        return hits or []
    return _fallback


def browser_candidate(video_id, title, artist, mmss="3:00"):
    """Candidate shape produced by the web BrowserYouTubeMusicResolver."""
    parts = mmss.split(":")
    seconds = int(parts[0]) * 60 + int(parts[1])
    return {
        "videoId": video_id,
        "title": title,
        "artists": [{"name": artist}],
        "artist": artist,
        "duration": mmss,
        "duration_seconds": seconds,
        "thumbnails": [{"url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"}],
    }


def raw_candidate(video_id, title, artist, mmss="3:00"):
    """Server-side (provider) candidate shape used by the fallback chain."""
    parts = mmss.split(":")
    duration = int(parts[0]) * 60 + int(parts[1])
    return {
        "videoId": video_id,
        "title": title,
        "artists": [{"name": artist}],
        "artist": artist,
        "duration": mmss,
        "duration_seconds": duration,
        "thumbnail": [{"url": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"}],
    }


@pytest.fixture
def mock_db():
    """Mock MongoDB for pipeline / endpoint tests."""
    db = MagicMock()
    db.PLAYLISTS = "playlists"
    db.LIKED_SONGS = "likedSongs"
    db.USERS = "users"

    def cursor(items):
        c = AsyncMock()
        c.__aiter__.return_value = iter(items)
        return c

    db[db.LIKED_SONGS].find = MagicMock(return_value=cursor([]))
    db[db.PLAYLISTS].find = MagicMock(return_value=cursor([]))
    db[db.PLAYLISTS].insert_one = AsyncMock()
    return db


@pytest.fixture
def client(mock_db):
    """AsyncClient against the FastAPI app with auth + DB mocked."""
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=mock_db)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return {
            "id": "507f1f77bcf86cd799439011",
            "username": "testuser",
            "email": "test@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


# ---------------------------------------------------------------------------
# _search_candidates: injected (browser) preference
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_candidates_injected_preferred_no_provider_call(monkeypatch):
    """Non-empty injected candidates are ranked directly; no provider is hit."""
    ctx = ImportContext()
    calls = {"n": 0}

    def boom(q, filter=None):
        calls["n"] += 1
        raise AssertionError("provider must NOT be called when candidates are injected")

    monkeypatch.setattr("app.services.ytmusic.search_ytmusic_detailed", boom)

    injected = [
        browser_candidate("vidaaaaaaaa", "Exact Song", "Exact Artist", "3:30"),
        browser_candidate("vidbbbbbbbb", "Exact Song", "Exact Artist (Live)", "4:05"),
    ]
    res = await _search_candidates(ctx, "Exact Song", "Exact Artist", 210, injected=injected)

    assert res["status"] == STATUS_MATCHED
    assert "browser candidate(s)" in res["reason"]
    assert calls["n"] == 0
    assert ctx.searches_used == 0
    assert len(res["candidates"]) == 2
    assert res["candidates"][0][0]["videoId"] == "vidaaaaaaaa"


@pytest.mark.asyncio
async def test_search_candidates_injected_empty_falls_back_to_provider(monkeypatch):
    """Empty injected list must fall through to the fallback provider chain,
    which (browser-only policy) goes through yt-dlp/public providers, never
    ytmusicapi."""
    ctx = ImportContext()

    monkeypatch.setattr(
        "app.services.ytfallback.search_fallback",
        fake_fallback(("", [raw_candidate("sv", "Exact Song", "Exact Artist")])),
    )
    res = await _search_candidates(ctx, "Exact Song", "Exact Artist", 180, injected=[])

    assert res["status"] == STATUS_MATCHED
    assert res["candidates"][0][0]["videoId"] == "sv"
    assert ctx.searches_used == 1


@pytest.mark.asyncio
async def test_search_candidates_injected_none_falls_back_to_provider(monkeypatch):
    """None injected behaves exactly like the un-injected path (old default)."""
    ctx = ImportContext()

    monkeypatch.setattr(
        "app.services.ytfallback.search_fallback",
        fake_fallback(("", [raw_candidate("sv2", "Song", "Artist")])),
    )
    res = await _search_candidates(ctx, "Song", "Artist", 180, injected=None)

    assert res["status"] == STATUS_MATCHED
    assert res["candidates"][0][0]["videoId"] == "sv2"


# ---------------------------------------------------------------------------
# _match_track: injected candidates short-circuit provider search
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_match_track_injected_preferred(monkeypatch, mock_db):
    """A strong injected candidate wins without any provider call."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()

        def boom(q, filter=None):
            raise AssertionError("provider must not run when injected")

        monkeypatch.setattr("app.services.ytmusic.search_ytmusic_detailed", boom)

        injected = [browser_candidate("br0br0br0br", "Exact Song", "Exact Artist", "3:45")]
        res = await _match_track(
            ctx, {"title": "Exact Song", "artist": "Exact Artist", "duration": 225},
            injected=injected,
        )

        assert res["status"] == STATUS_MATCHED
        assert res["match"]["videoId"] == "br0br0br0br"
        # Search-derived matches are labelled 'similar' (same as the provider
        # chain) unless the track carried a direct videoId.
        assert res["match_type"] == "similar"
        assert res["confidence"] >= HIGH_CONFIDENCE_THRESHOLD
        assert ctx.searches_used == 0


@pytest.mark.asyncio
async def test_match_track_injected_empty_uses_server_fallback(monkeypatch, mock_db):
    """Empty injected candidates let the fallback provider chain resolve the
    track (browser-only policy: via yt-dlp/public providers, never ytmusicapi)."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()

        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback",
            fake_fallback(("", [raw_candidate("svf", "Exact Song", "Exact Artist")])),
        )

        res = await _match_track(
            ctx, {"title": "Exact Song", "artist": "Exact Artist", "duration": 180},
            injected=[],
        )

        assert res["status"] == STATUS_MATCHED
        assert res["match"]["videoId"] == "svf"
        assert ctx.searches_used >= 1


@pytest.mark.asyncio
async def test_match_track_injected_weak_single_candidate_is_not_found(monkeypatch, mock_db):
    """A single weak injected candidate cannot clear thresholds; short-circuit
    semantics mean the provider chain is NOT consulted, so the track is
    genuinely not matched (not_found), never a false provider failure."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()

        def boom(q, filter=None):
            raise AssertionError("provider must not run when injected candidates exist")

        monkeypatch.setattr("app.services.ytmusic.search_ytmusic_detailed", boom)

        injected = [browser_candidate("brXbrXbrXbr", "Totally Different Title", "Other Artist")]
        res = await _match_track(
            ctx, {"title": "Some Track", "artist": "The Real Artist", "duration": 200},
            injected=injected,
        )
        assert res["status"] == STATUS_NOT_FOUND

        # Also: with NO injected candidates and a provider outage, the same
        # track must NOT be mislabelled as not_found.
        ctx2 = ImportContext()

        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback", fake_fallback(("", []))
        )
        res2 = await _match_track(
            ctx2, {"title": "Some Track", "artist": "The Real Artist", "duration": 200},
            injected=[],
        )
        assert res2["status"] == STATUS_UNREACHABLE
        assert res2["status"] != STATUS_NOT_FOUND


# ---------------------------------------------------------------------------
# _run_import_pipeline: resolve_map (browser candidates per track index)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pipeline_resolve_map_prefers_browser_then_falls_back(monkeypatch, mock_db):
    """Track 0 matched via browser vid; track 1 (no injected) matched via
    fallback provider (yt-dlp/public, never ytmusicapi)."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback",
            fake_fallback(("", [raw_candidate("server-1", "Song Two", "Artist Two")])),
        )

        ctx = ImportContext()
        parsed = [
            {"title": "Song One", "artist": "Artist One", "album": ""},
            {"title": "Song Two", "artist": "Artist Two", "album": ""},
        ]
        resolve_map = {0: [browser_candidate("browser-0xx", "Song One", "Artist One", "3:10")]}

        result = await _run_import_pipeline(
            ctx, parsed, user_id="507f1f77bcf86cd799439011", source="csv", import_name="Test", resolve_map=resolve_map
        )

        matched = result["data"]["matched"]
        vid_ids = {s["videoId"] for s in result["data"]["matched"] + result["data"]["similar_matches"]}
        assert "browser-0xx" in vid_ids
        assert "server-1" in vid_ids
        # Browser candidates consumed no search budget (only track 1 searched).
        assert result["data"]["searches_used"] == 1
        # Playlist persisted with the matched songs.
        insert_call = mock_db[mock_db.PLAYLISTS].insert_one.await_args
        assert insert_call is not None
        inserted = insert_call.args[0]
        assert {"browser-0xx", "server-1"}.issubset({s["videoId"] for s in inserted["songs"]})


@pytest.mark.asyncio
async def test_pipeline_resolve_map_missing_index_falls_back(monkeypatch, mock_db):
    """Indexes absent from resolve_map always use the fallback provider chain."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback",
            fake_fallback(("", [raw_candidate("srv", "Only Song", "Only Artist")])),
        )

        ctx = ImportContext()
        parsed = [{"title": "Only Song", "artist": "Only Artist", "album": ""}]
        result = await _run_import_pipeline(
            ctx, parsed, user_id="507f1f77bcf86cd799439011", source="csv", import_name="Test",
            resolve_map={7: [browser_candidate("other", "X", "Y")]},  # index 7 != 0
        )

        matched = result["data"]["matched"] + result["data"]["similar_matches"]
        assert [s["videoId"] for s in matched] == ["srv"]


# ---------------------------------------------------------------------------
# Endpoint: /playlists/import/parse (no resolution)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_parse_returns_tracks_without_resolution(client):
    """/import/parse returns the raw track rows; nothing is searched."""
    import app.services.ytmusic as yt

    calls = {"n": 0}
    orig = yt.search_ytmusic_detailed

    def boom(q, filter=None):
        calls["n"] += 1
        raise AssertionError("parse must not resolve")

    yt.search_ytmusic_detailed = boom
    try:
        response = await client.post(
            "/playlists/import/parse",
            json={"source": "csv", "name": "Test", "data": "title,artist\nHeer,A R Rahman\n"},
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert calls["n"] == 0
    assert body["tracks"] == [{"title": "Heer", "artist": "A R Rahman", "album": ""}]


@pytest.mark.asyncio
async def test_import_parse_empty_data_error(client):
    response = await client.post(
        "/playlists/import/parse",
        json={"source": "csv", "name": "Test", "data": ""},
    )
    body = response.json()
    assert body["success"] is False
    assert body["tracks"] == []


# ---------------------------------------------------------------------------
# Endpoint: /playlists/import/resolve (browser candidates preferred)
# ---------------------------------------------------------------------------

CSV = "title,artist,album\nHeer,A R Rahman,Jab Tak Hai Jaan\nRare Song,Nobody,\n"


@pytest.mark.asyncio
async def test_import_resolve_uses_browser_candidates(client):
    """Browser candidate for track 0 is matched; track 1 falls back to the
    fallback provider chain (browser-only policy)."""
    monkeypatch_patch = patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(
            ("rare song", [raw_candidate("srv-rare", "Rare Song", "Nobody")]),
            ("", []),
        ),
    )
    mp = monkeypatch_patch
    with mp:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [browser_candidate("brHeerHeerH", "Heer", "A R Rahman", "5:53")],
                    "9": {"garbage": "ignored"},
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    matched_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    # Browser candidate used for Heer (no provider search for it).
    assert "brHeerHeerH" in matched_ids
    # Rare Song fell back to the fallback provider result.
    assert "srv-rare" in matched_ids
    assert data["total_matched"] + data["total_similar"] == 2


@pytest.mark.asyncio
async def test_import_resolve_sanitizes_bad_candidates(client):
    """Malformed / videoId-less candidates are dropped before ranking; the
    remaining valid candidates are ranked, and the winning one becomes the
    song. No server search runs for a track that has valid injected
    candidates."""
    def fake(q, filter=None):
        return make_outcome("ok", results=[raw_candidate("srv-heer", "Heer", "A R Rahman")])

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = fake
    try:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [
                        {"title": "no video id here"},
                        {"videoId": "  "},
                        "not-a-dict",
                        browser_candidate("brOkbrOkbrO", "Heer", "A R Rahman"),
                        browser_candidate("brOkbrOkbrK", "Heer", "A R Rahman"),
                    ],
                },
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    matched_ids = {s["videoId"] for s in body["data"]["matched"] + body["data"]["similar_matches"]}
    # The invalid entries were dropped, so only valid injected candidates were
    # ranked; the top-ranked one became the song. Track 1 (no browser
    # candidates) fell back to the server chain, hence exactly 1 search.
    assert "brOkbrOkbrO" in matched_ids
    assert body["data"]["searches_used"] == 1


@pytest.mark.asyncio
async def test_import_resolve_all_bad_candidates_falls_back_to_server(client):
    """When every injected candidate is malformed, the track falls back to the
    fallback provider chain (same as having no browser candidates)."""
    with patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(("", [raw_candidate("srv-heer", "Heer", "A R Rahman")])),
    ):
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [{"title": "bad"}, {"videoId": "  "}, 42],
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    matched_ids = {s["videoId"] for s in body["data"]["matched"] + body["data"]["similar_matches"]}
    assert "srv-heer" in matched_ids


@pytest.mark.asyncio
async def test_import_resolve_no_candidates_is_pure_server_fallback(client):
    """With no candidates map the endpoint behaves like /import (server-side
    fallback via yt-dlp/public providers — never ytmusicapi)."""
    with patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(("", [raw_candidate("srv-heer", "Heer", "A R Rahman")])),
    ):
        response = await client.post(
            "/playlists/import/resolve",
            json={"source": "csv", "name": "Test", "data": CSV, "candidates": {}},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    matched_ids = {s["videoId"] for s in body["data"]["matched"] + body["data"]["similar_matches"]}
    assert "srv-heer" in matched_ids


# ---------------------------------------------------------------------------
# /import/parse — expanded: Spotify + YT Music, shape, determinism, edges
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_parse_spotify_url_returns_tracks(monkeypatch, client):
    """Spotify URL parse returns the extractor's rows verbatim and never
    resolves anything (no provider search)."""
    rows = [
        {"title": "Heer", "artist": "A R Rahman", "album": "Jab Tak Hai Jaan", "duration": 353},
        {"title": "Gerua", "artist": "Arijit Singh, Antara Mitra", "album": "Dilwale", "duration": 344},
    ]

    async def fake_extract(url):
        return rows

    monkeypatch.setattr("app.routes.playlist.extract_spotify_playlist", fake_extract)

    import app.services.ytmusic as yt
    calls = {"n": 0}
    orig = yt.search_ytmusic_detailed

    def boom(q, filter=None):
        calls["n"] += 1
        raise AssertionError("parse must not resolve tracks")

    yt.search_ytmusic_detailed = boom
    try:
        response = await client.post(
            "/playlists/import/parse",
            json={
                "source": "spotify",
                "name": "Test",
                "data": "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc",
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    # Contract the web PlaylistImport.tsx consumes: {success, tracks} on OK.
    assert set(body.keys()) == {"success", "tracks"}
    assert body["success"] is True
    assert body["tracks"] == rows
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_import_parse_ytmusic_url_never_egresses(monkeypatch, client):
    """Browser-only policy: YouTube URL parse must NEVER call the server-side
    YouTube Music extractor (extract_ytmusic_playlist). The API's egress IP is
    YouTube-blocked, so a bare YouTube URL (no line-by-line rows) yields an
    empty parse instead of egressing to ytmusicapi."""
    called = {"n": 0}

    async def fake_extract(url):
        called["n"] += 1
        return [{"title": "Heer", "artist": "A R Rahman"}]

    monkeypatch.setattr("app.routes.playlist.extract_ytmusic_playlist", fake_extract)

    response = await client.post(
        "/playlists/import/parse",
        json={
            "source": "youtube",
            "name": "Test",
            "data": "https://music.youtube.com/playlist?list=PL4fGSI1pDJnBkXo12VOZcrh4CkOSjiD4w",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is False
    assert body["tracks"] == []
    assert called["n"] == 0  # the server extractor must never be invoked


@pytest.mark.asyncio
async def test_import_parse_track_order_and_duplicates_preserved(monkeypatch, client):
    """Parse output is deterministic and does NOT de-duplicate: the browser
    candidates are keyed by position, so order must be stable and duplicates
    must survive to the resolve step."""
    row_a = {"title": "Heer", "artist": "A R Rahman", "album": "", "duration": 353}
    row_b = {"title": "Gerua", "artist": "Arijit Singh, Antara Mitra", "album": "", "duration": 344}

    async def fake_extract(url):
        return [row_a, row_b, row_a]

    monkeypatch.setattr("app.routes.playlist.extract_spotify_playlist", fake_extract)

    url = {"source": "spotify", "name": "Test", "data": "https://open.spotify.com/playlist/x?si=y"}
    first = (await client.post("/playlists/import/parse", json=url)).json()
    second = (await client.post("/playlists/import/parse", json=url)).json()

    assert first == second == {"success": True, "tracks": [row_a, row_b, row_a]}


@pytest.mark.asyncio
async def test_import_parse_missing_metadata_rows_survive(monkeypatch, client):
    """Rows with incomplete metadata (no artist / no album / empty dict) are
    passed through untouched so the browser can still attempt resolution. For
    YouTube input, the browser-only policy means parse never egresses to
    ytmusicapi; only the line-by-line fallback (metadata-only) can yield rows."""
    called = {"n": 0}

    async def fake_extract(url):
        called["n"] += 1
        return [{"title": "Heer", "artist": "A R Rahman"}]

    monkeypatch.setattr("app.routes.playlist.extract_ytmusic_playlist", fake_extract)

    response = await client.post(
        "/playlists/import/parse",
        json={"source": "youtube", "name": "Test", "data": "Only Title - Some Singer"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["tracks"] == [{"title": "Only Title", "artist": "Some Singer", "album": ""}]
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_import_parse_extraction_failure_structured_error(monkeypatch, client):
    """Empty extraction from a URL returns {success: false, tracks: [], error}
    with the URL-specific message — never a crash and never a generic 500."""
    async def fake_empty(url):
        return []

    monkeypatch.setattr("app.routes.playlist.extract_spotify_playlist", fake_empty)
    monkeypatch.setattr("app.routes.playlist.extract_ytmusic_playlist", fake_empty)

    spotify = await client.post(
        "/playlists/import/parse",
        json={"source": "spotify", "name": "T", "data": "https://open.spotify.com/playlist/abc?si=x"},
    )
    body = spotify.json()
    assert spotify.status_code == 200
    assert set(body.keys()) == {"success", "tracks", "error"}
    assert body["success"] is False
    assert body["tracks"] == []
    assert body["error"] == "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."

    yt = await client.post(
        "/playlists/import/parse",
        json={"source": "youtube", "name": "T", "data": "https://music.youtube.com/playlist?list=PLx"},
    )
    body = yt.json()
    assert body["success"] is False
    assert body["error"] == "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."


@pytest.mark.asyncio
async def test_import_parse_non_http_empty_error_message(client):
    """Non-URL, non-Spotify empty input gets its own friendly message."""
    response = await client.post(
        "/playlists/import/parse",
        json={"source": "csv", "name": "T", "data": ""},
    )
    body = response.json()
    assert body["success"] is False
    assert body["tracks"] == []
    assert body["error"] == "No tracks found in the provided import data. Check your format and try again."


# ---------------------------------------------------------------------------
# /import/resolve — expanded: index association, edges, robustness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_resolve_all_tracks_have_browser_candidates_skip_provider(client):
    """When EVERY track has injected browser candidates, no provider search
    runs at all (searches_used == 0) and each track mates with its own vid."""
    def boom(q, filter=None):
        raise AssertionError("provider must not run when every track is browser-resolved")

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = boom
    try:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [browser_candidate("brHeerHeerH", "Heer", "A R Rahman", "5:53")],
                    "1": [browser_candidate("brRareRareR", "Rare Song", "Nobody", "4:02")],
                },
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    matched_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    assert matched_ids == {"brHeerHeerH", "brRareRareR"}
    assert data["searches_used"] == 0
    assert data["total_tracks"] == 2


@pytest.mark.asyncio
async def test_import_resolve_out_of_range_and_nonint_indexes_ignored(client):
    """Indexes that are out of range or non-int are dropped; the affected
    tracks still resolve through the fallback provider chain."""
    with patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(
            ("rare song", [raw_candidate("srv-rare", "Rare Song", "Nobody")]),
            ("", [raw_candidate("srv-heer", "Heer", "A R Rahman")]),
        ),
    ):
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "5": [browser_candidate("aa", "Heer", "A R Rahman")],
                    "-1": [browser_candidate("bb", "Heer", "A R Rahman")],
                    "abc": [browser_candidate("cc", "Heer", "A R Rahman")],
                    "none": [browser_candidate("dd", "Heer", "A R Rahman")],
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    matched_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    assert matched_ids == {"srv-heer", "srv-rare"}
    # Both tracks fell back to the fallback chain.
    assert data["searches_used"] == 2


@pytest.mark.asyncio
async def test_import_resolve_duplicate_index_last_key_wins(client):
    """Object keys "0" and "00" both coerce to index 0; the later key
    overwrites deterministically, so br-b (not br-a) becomes the track."""
    def fake(q, filter=None):
        if "rare" in q.lower():
            return make_outcome("ok", results=[raw_candidate("srv-rare", "Rare Song", "Nobody")])
        return make_outcome("ok", results=[raw_candidate("srv-heer", "Heer", "A R Rahman")])

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = fake
    try:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [browser_candidate("brAbrAbrAbr", "Heer", "A R Rahman", "5:53")],
                    "00": [browser_candidate("brBbrBbrBbr", "Heer", "A R Rahman", "5:53")],
                },
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    matched_ids = {s["videoId"] for s in body["data"]["matched"] + body["data"]["similar_matches"]}
    assert "brBbrBbrBbr" in matched_ids
    assert "brAbrAbrAbr" not in matched_ids


@pytest.mark.asyncio
async def test_import_resolve_numeric_video_id_candidate_dropped(client):
    """A non-string videoId candidate is malformed: it must be dropped, not
    crash the import. Valid siblings still resolve."""
    with patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(("", [raw_candidate("srv-heer", "Heer", "A R Rahman")])),
    ):
        # Only a numeric videoId -> candidate dropped -> fallback provider.
        pure = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [{"videoId": 12345, "title": "Heer", "artist": "A R Rahman"}],
                },
            },
        )
        # Mixed: numeric sibling dropped, valid sibling still used.
        mixed = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [
                        {"videoId": 12345, "title": "Heer", "artist": "A R Rahman"},
                        browser_candidate("brOkbrOkbrO", "Heer", "A R Rahman"),
                    ],
                },
            },
        )

    pure_body = pure.json()
    assert pure.status_code == 200
    assert pure_body["success"] is True
    pure_ids = {s["videoId"] for s in pure_body["data"]["matched"] + pure_body["data"]["similar_matches"]}
    assert "srv-heer" in pure_ids  # malformed candidate never becomes a match

    mixed_body = mixed.json()
    assert mixed.status_code == 200
    assert mixed_body["success"] is True
    mixed_ids = {s["videoId"] for s in mixed_body["data"]["matched"] + mixed_body["data"]["similar_matches"]}
    assert "brOkbrOkbrO" in mixed_ids


@pytest.mark.asyncio
async def test_import_resolve_strict_video_id_validation(client):
    """P2: /import/resolve enforces the canonical 11-char videoId format on
    browser-supplied candidates. Every malformed id (too short, too long, bad
    chars, blank, non-string) is dropped; a VALID sibling candidate still
    resolves — one bad candidate can never poison the track."""
    with patch(
        "app.services.ytfallback.search_fallback",
        fake_fallback(
            ("rare", [raw_candidate("srv-rare", "Rare Song", "Nobody")]),
            ("", [raw_candidate("srv-heer", "Heer", "A R Rahman")]),
        ),
    ):
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [
                        {"videoId": "abc123", "title": "Heer", "artist": "A R Rahman"},
                        {"videoId": "dQw4w9WgXcQabcdef", "title": "Heer", "artist": "A R Rahman"},
                        {"videoId": "not-a-video!", "title": "Heer", "artist": "A R Rahman"},
                        {"videoId": "  ", "title": "Heer", "artist": "A R Rahman"},
                        {"videoId": "", "title": "Heer", "artist": "A R Rahman"},
                        {"videoId": 12345, "title": "Heer", "artist": "A R Rahman"},
                        {"title": "no id at all"},
                        browser_candidate("brOkbrOkbrO", "Heer", "A R Rahman"),
                    ],
                },
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    matched_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    # Rejecting the six malformed candidates must not block the valid sibling.
    assert "brOkbrOkbrO" in matched_ids
    # None of the malformed ids can ever become a matched song.
    for bad in ("abc123", "dQw4w9WgXcQabcdef", "not-a-video!"):
        assert bad not in matched_ids
    # Track 2 (no browser candidates) fell back to the fallback chain.
    assert "srv-rare" in matched_ids
    assert data["searches_used"] == 1


@pytest.mark.asyncio
async def test_import_resolve_whitespace_wrapped_video_id_normalized(client):
    """P2: whitespace-wrapped canonical ids pass validation (strip-then-check)
    and are persisted in their stripped canonical form — never verbatim."""
    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = lambda q, filter=None: make_outcome("ok", results=[])
    try:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": CSV,
                "candidates": {
                    "0": [browser_candidate("  dQw4w9WgXcQ  ", "Heer", "A R Rahman", "5:53")],
                    "1": [browser_candidate("dQw4w9WgXcQ", "Rare Song", "Nobody", "4:02")],
                },
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    matched_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    assert "dQw4w9WgXcQ" in matched_ids
    assert all(v == v.strip() for v in matched_ids)


@pytest.mark.asyncio
async def test_import_resolve_ambiguous_candidates_go_through_matcher(client):
    """Multiple plausible-injected candidates with low confidence land in the
    `ambiguous` bucket (never a crash, never a fabricated not_found)."""
    def boom(q, filter=None):
        raise AssertionError("provider must not run when injected candidates exist")

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = boom
    try:
        response = await client.post(
            "/playlists/import/resolve",
            json={
                "source": "csv",
                "name": "Test",
                "data": "title,artist\nSong X,Nobody\n",
                "candidates": {
                    "0": [
                        browser_candidate("brAbrAbrAbr", "Song X", "Artist A", "3:01"),
                        browser_candidate("brBbrBbrBbr", "Song X", "Artist C", "3:02"),
                        browser_candidate("brCbrCbrCbr", "Song X", "Artist F", "3:04"),
                    ],
                },
            },
        )
    finally:
        yt.search_ytmusic_detailed = orig

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    assert data["matched"] + data["similar_matches"] == []
    assert len(data["ambiguous"]) == 1
    assert data["ambiguous"][0]["title"] == "Song X"
    assert data["ambiguous"][0]["status"] == "ambiguous"
    assert data["searches_used"] == 0


@pytest.mark.asyncio
async def test_import_resolve_provider_failure_reported_as_failed(client):
    """A provider outage during fallback is surfaced as `failed`/`unreachable`
    per track — NEVER classified as not_found."""
    with patch("app.services.ytfallback.search_fallback", fake_fallback(("", []))):
        response = await client.post(
            "/playlists/import/resolve",
            json={"source": "csv", "name": "Test", "data": CSV, "candidates": {}},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    assert len(data["failed"]) == 2
    assert all(t["status"] == "unreachable" for t in data["failed"])
    assert data["not_found"] == []