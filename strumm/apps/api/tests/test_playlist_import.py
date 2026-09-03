"""
Tests for the playlist importer's song-matching pipeline.

Covers the status taxonomy fix: a transient provider/network failure must be
classified as ``unreachable``/``rate_limited``/``timeout``/``provider_error``
(never falsely ``not_found``/Missing), the fallback query plan, and that the
``/playlists/import`` endpoint surfaces these reasons. YTMusic and MongoDB
are mocked so no external service is needed.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.routes.playlist import (
    ImportContext,
    _build_query_plan,
    _classify_track_metadata,
    _match_track,
    _provider_search,
    _rank_candidates,
    _variant_penalty,
    STATUS_MATCHED,
    STATUS_NOT_FOUND,
    STATUS_UNREACHABLE,
    STATUS_RATE_LIMITED,
    STATUS_TIMEOUT,
    STATUS_PROVIDER_ERROR,
    STATUS_INVALID_METADATA,
    STATUS_AMBIGUOUS,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_outcome(status="ok", found=None, results=None, reason="ok"):
    """Build a minimal YTSearchOutcome-like object."""
    if found is None:
        found = status == "ok" and bool(results)
    return MagicMock(found=found, status=status, reason=reason, results=results or [])


def raw_candidate(video_id, title, artist, duration=200):
    return {
        "videoId": video_id,
        "title": title,
        "artists": [{"name": artist}],
        "artist": artist,
        "duration": duration,
        "length": duration,
        "thumbnail": [{"url": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"}],
    }


def mock_ytmusic_search(monkeypatch, *outcomes):
    """Patch search_ytmusic_detailed to return the given outcomes in order."""
    calls = {"n": 0}

    def fake(q, filter=None):
        idx = calls["n"]
        calls["n"] += 1
        out = outcomes[min(idx, len(outcomes) - 1)]
        return out

    monkeypatch.setattr("app.services.ytmusic.search_ytmusic_detailed", fake)


@pytest.fixture
def mock_db():
    """Mock MongoDB: empty liked-songs and playlists collections.""" 
    db = MagicMock()
    db.PLAYLISTS = "playlists"
    db.LIKED_SONGS = "likedSongs"
    db.USERS = "users"

    def make_cursor(items):
        cur = AsyncMock()
        cur.__aiter__.return_value = iter(items)
        return cur

    db[db.LIKED_SONGS].find = MagicMock(return_value=make_cursor([]))
    db[db.PLAYLISTS].find = MagicMock(return_value=make_cursor([]))
    return db


# ---------------------------------------------------------------------------
# Fallback query plan
# ---------------------------------------------------------------------------


def test_build_query_plan_plain():
    plan = _build_query_plan("Cold Water", "Justin Bieber")
    assert "Cold Water Justin Bieber" in plan


def test_build_query_plan_strips_feat_and_dedupes():
    plan = _build_query_plan("Despacito (feat. Luis Fonsi)", "Luis Fonsi & Daddy Yankee")
    # First is title + artist
    assert plan[0] == "Despacito (feat. Luis Fonsi) Luis Fonsi & Daddy Yankee"
    # A title-only variant with feat removed should appear.
    assert any("Despacito" in q for q in plan[1:])


def test_build_query_plan_no_duplicate_empty_queries():
    plan = _build_query_plan("Hey Jude", "")
    assert len(plan) == len(set(q.lower() for q in plan))
    assert all(q.strip() for q in plan)


# ---------------------------------------------------------------------------
# Metadata classification
# ---------------------------------------------------------------------------


def test_invalid_metadata_when_no_title():
    assert _classify_track_metadata({"artist": "Someone"}) == STATUS_INVALID_METADATA
    assert _classify_track_metadata({"title": "   "}) == STATUS_INVALID_METADATA


def test_valid_metadata():
    assert _classify_track_metadata({"title": "Song", "artist": "Artist"}) is None


# ---------------------------------------------------------------------------
# _provider_search: transient failures vs genuine no-results
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provider_search_retries_then_unreachable(monkeypatch):
    ctx = ImportContext()
    # Both attempts unreachable -> after retry, returns unreachable (not ok/not_found)
    outcomes = [make_outcome("unreachable", reason="host down"),
                make_outcome("unreachable", reason="host down")]
    mock_ytmusic_search(monkeypatch, *outcomes)
    res = await _provider_search(ctx, "query one")
    assert res["status"] == STATUS_UNREACHABLE
    assert res["found"] is False
    # Retries reuse the same logical query; the search budget counts distinct
    # queries, so searches_used stays 1.
    assert ctx.searches_used == 1


@pytest.mark.asyncio
async def test_provider_search_gives_up_on_rate_limit(monkeypatch):
    ctx = ImportContext()
    outcomes = [make_outcome("rate_limited", reason="429"),
                make_outcome("rate_limited", reason="429")]
    mock_ytmusic_search(monkeypatch, *outcomes)
    res = await _provider_search(ctx, "query two")
    assert res["status"] == STATUS_RATE_LIMITED


@pytest.mark.asyncio
async def test_provider_search_genuine_no_results(monkeypatch):
    ctx = ImportContext()
    mock_ytmusic_search(monkeypatch, make_outcome("ok", results=[]))
    res = await _provider_search(ctx, "rare song")
    assert res["status"] == STATUS_NOT_FOUND
    assert res["found"] is False


@pytest.mark.asyncio
async def test_provider_search_caches_same_query(monkeypatch):
    ctx = ImportContext()
    mock_ytmusic_search(monkeypatch, make_outcome("ok", results=[raw_candidate("a", "X", "Y")]))
    r1 = await _provider_search(ctx, "same query")
    r2 = await _provider_search(ctx, "SAME QUERY")
    assert r1 is r2  # cached
    assert ctx.searches_used == 1


# ---------------------------------------------------------------------------
# _match_track status taxonomy
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_match_track_exact_video_id(monkeypatch):
    ctx = ImportContext()
    res = await _match_track(ctx, {"title": "Song", "artist": "Artist", "videoId": "dQw4w9WgXcQ"})
    assert res["status"] == STATUS_MATCHED
    assert res["match"]["videoId"] == "dQw4w9WgXcQ"
    assert res["match_type"] == "exact"


@pytest.mark.asyncio
async def test_match_track_provider_failure_is_not_not_found(monkeypatch, mock_db):
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        # Lambda query is only reachable after search fails.
        outcomes = [make_outcome("timeout", reason="took too long"),
                    make_outcome("timeout", reason="took too long")]
        mock_ytmusic_search(monkeypatch, *outcomes)
        res = await _match_track(ctx, {"title": "Some Track", "artist": "Some Artist"})
        # Transient failure: must NOT be 'not_found'.
        assert res["status"] == STATUS_TIMEOUT
        assert res["status"] != STATUS_NOT_FOUND
        assert res["match"] is None
        assert res["reason"]  # a human-readable diagnostic is provided


@pytest.mark.asyncio
async def test_match_track_genuine_not_found(monkeypatch, mock_db):
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        mock_ytmusic_search(monkeypatch, make_outcome("ok", results=[]))
        res = await _match_track(ctx, {"title": "Rare Track", "artist": "Nobody"})
        assert res["status"] == STATUS_NOT_FOUND
        assert res["match"] is None


@pytest.mark.asyncio
async def test_match_track_ambiguous(monkeypatch, mock_db):
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        results = [
            raw_candidate("c1", "Song X", "Artist A"),
            raw_candidate("c2", "Song X", "Artist B"),
            raw_candidate("c3", "Song X", "Artist C"),
        ]
        mock_ytmusic_search(monkeypatch, make_outcome("ok", results=results))
        res = await _match_track(ctx, {"title": "Song X", "artist": "Artist A"})
        # candidates exist but below high threshold with multiple options
        assert res["status"] in (STATUS_MATCHED, STATUS_AMBIGUOUS)


@pytest.mark.asyncio
async def test_match_track_exact_search_match(monkeypatch, mock_db):
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        results = [raw_candidate("c1", "Exact Song", "Exact Artist")]
        mock_ytmusic_search(monkeypatch, make_outcome("ok", results=results))
        res = await _match_track(ctx, {"title": "Exact Song", "artist": "Exact Artist"})
        assert res["status"] == STATUS_MATCHED
        assert res["match"]["videoId"] == "c1"


# ---------------------------------------------------------------------------
# Variant qualifier penalty (Bug 5 regression): a wrong live/acoustic/remix
# version must not outrank the correct recording.
# ---------------------------------------------------------------------------


def test_variant_penalty_live_vs_plain():
    # Source has no qualifier, candidate is a live version -> 0.08.
    assert _variant_penalty("Rockstar", "Rockstar (Live)") == 0.08
    # Symmetric: the penalty is applied whichever side carries the qualifier.
    assert _variant_penalty("Rockstar (Live)", "Rockstar") == 0.08


def test_variant_penalty_live_vs_acoustic():
    # Both sides carry *different* qualifiers -> 0.12.
    assert _variant_penalty("Rockstar (Live)", "Rockstar (Acoustic)") == 0.12


def test_variant_penalty_identical_or_non_variant():
    # Same qualifier set (or neither side has qualifiers) -> no penalty.
    assert _variant_penalty("Rockstar", "Rockstar") == 0.0
    assert _variant_penalty("Rockstar (Live)", "Rockstar (Live)") == 0.0


def test_rank_candidates_studio_beats_live():
    """When otherwise similar, the correct (studio/plain) recording must be
    ranked above the (Live) variant. Verifies the final selected candidate via
    _rank_candidates, not just the internal penalty constant."""
    imported = {"title": "Rockstar", "artist": "Post Malone", "duration": 200}
    candidates = [
        raw_candidate("studio00001", "Rockstar", "Post Malone"),
        raw_candidate("live0000001", "Rockstar (Live)", "Post Malone"),
        raw_candidate("acoustic000", "Rockstar (Acoustic)", "Post Malone"),
    ]
    ranked = _rank_candidates(imported, candidates)
    assert ranked, "expected at least one ranked candidate"
    top_video_id, _ = ranked[0]
    assert top_video_id["videoId"] == "studio00001"
    # The live/acoustic variants must be ranked BELOW the plain studio cut.
    ranked_ids = [item["videoId"] for item, _ in ranked]
    assert ranked_ids.index("studio00001") < ranked_ids.index("live0000001")
    assert ranked_ids.index("studio00001") < ranked_ids.index("acoustic000")


# ---------------------------------------------------------------------------
# Server-side videoId validation (P2): Stage-1 exact-match gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_match_track_invalid_video_id_does_not_exact_match(monkeypatch, mock_db):
    """A malformed videoId must not short-circuit to an exact match: the track
    falls through to search so a real canonical id can be resolved instead."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        results = [raw_candidate("searchvid01", "Heer", "A R Rahman")]
        mock_ytmusic_search(monkeypatch, make_outcome("ok", results=results))
        res = await _match_track(
            ctx, {"title": "Heer", "artist": "A R Rahman", "videoId": "abc123"}
        )
        assert res["status"] == STATUS_MATCHED
        # Resolved via search, NOT via the (invalid) exact id.
        assert res["match_type"] != "exact"
        assert res["match"]["videoId"] == "searchvid01"


# ---------------------------------------------------------------------------
# Endpoint: /playlists/import surfaces status reasons
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db_empty():
    db = MagicMock()
    db.PLAYLISTS = "playlists"
    db.LIKED_SONGS = "likedSongs"
    db.USERS = "users"

    def make_cursor(items):
        cur = AsyncMock()
        cur.__aiter__.return_value = iter(items)
        return cur

    db[db.LIKED_SONGS].find = MagicMock(return_value=make_cursor([]))
    db[db.PLAYLISTS].find = MagicMock(return_value=make_cursor([]))

    db.PLAYLISTS = "playlists"
    db[db.PLAYLISTS].insert_one = AsyncMock()
    return db


# ---------------------------------------------------------------------------
# Endpoint integration
# ---------------------------------------------------------------------------


@pytest.fixture
def client(mock_db_empty):
    """Create an httpx AsyncClient pointed at the FastAPI app with auth mocked."""
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=mock_db_empty)

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
    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_import_csv_mixed_statuses(client, monkeypatch):
    """A CSV with (a) a provider match, (b) a genuine no-result, and (c) a
    transient provider failure should surface distinct statuses — the failure
    must NOT be folded into 'not_found'/'Missing'.

    The /import endpoint runs under the browser-only policy (forbid_ytmusic),
    so the server fallback is yt-dlp et al. via ``search_fallback``, which maps
    an empty result to ``unreachable`` (never a false not_found). Both the
    genuine-miss and the outage therefore surface as ``failed``/``unreachable``;
    only the provider match is ``matched``.
    """
    # search_fallback returns a flat candidate list per query: non-empty is a
    # match, empty maps to "unreachable" (provider couldn't prove absence).
    def fake(query, *, limit=10):
        q = query.lower()
        if "heer" in q:
            return [raw_candidate("v1", "Heer", "A R Rahman")]
        return []

    monkeypatch.setattr("app.services.ytfallback.search_fallback", fake)

    csv_data = "title,artist\nHeer,A R Rahman\nRare Song,Nobody\nVanishing Track,Unknown\n"

    response = await client.post(
        "/playlists/import",
        json={"source": "csv", "name": "Test", "data": csv_data},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]

    # Heer matched via provider fallback.
    assert len(data["matched"]) + len(data["similar_matches"]) >= 1
    # No track is ever fabricated as a match when the provider found nothing.
    assert all(s.get("status") != STATUS_MATCHED
               for s in data["failed"] + data["not_found"])
    # Under the browser-only yt-dlp seam an empty result is unreachable (the
    # provider could not prove absence), surfaced as `failed`, not not_found.
    assert "failed" in data and len(data["failed"]) >= 2
    assert all(
        s["title"] in ("Rare Song", "Vanishing Track")
        and s.get("status") in (STATUS_UNREACHABLE, STATUS_RATE_LIMITED,
                                STATUS_TIMEOUT, STATUS_PROVIDER_ERROR)
        for s in data["failed"]
    )
    assert data.get("total_failed") == len(data["failed"])
    assert data.get("total_not_found") == len(data["not_found"])
    # Response contract: per-bucket totals are always returned, including the
    # duplicate count (added for frontend/backend consistency).
    assert data.get("total_duplicates") == len(data["duplicates"])
    assert data.get("searches_used", 0) >= 1
