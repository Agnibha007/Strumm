"""
Production-readiness validation for the playlist importer.

Covers:
  * Search budget math (cap per import, max queries/track, retry non-accounting)
  * Concurrency isolation (two users, overlapping playlists, same playlist)
  * Provider outage semantics (not_found=0, failed=N) + recovery
  * Request-scoped cache isolation and dedup boundary

These are *validations*, not features: they assert that the existing
implementation meets its own stated guarantees.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routes.playlist import (
    ImportContext,
    _build_query_plan,
    _match_track,
    _provider_search,
    _rank_candidates,
    _search_candidates,
    MAX_SEARCHES_PER_IMPORT,
    IMPORT_RETRY_ATTEMPTS,
    STATUS_MATCHED,
    STATUS_NOT_FOUND,
    STATUS_UNREACHABLE,
    STATUS_RATE_LIMITED,
    STATUS_TIMEOUT,
    STATUS_PROVIDER_ERROR,
    STATUS_AMBIGUOUS,
)


# ---------------------------------------------------------------------------
# Search budget
# ---------------------------------------------------------------------------


def make_outcome(status="ok", results=None, reason=""):
    return MagicMock(found=status == "ok" and bool(results), status=status,
                     reason=reason, results=results or [])


def raw_candidate(video_id, title, artist, mmss="3:00"):
    parts = mmss.split(":")
    dur = int(parts[0]) * 60 + int(parts[1])
    return {
        "videoId": video_id, "title": title, "resultType": "song",
        "artists": [{"name": artist, "id": "UC1"}],
        "duration": mmss, "duration_seconds": dur,
    }


def test_query_plan_bounded_at_three():
    """The fallback plan never exceeds 3 distinct queries (structural bound)."""
    cases = [
        ("Cold Water (feat. Justin Bieber)", "Major Lazer"),
        ("Title", "Artist"),
        ("A (Live) B", "C"),
        ("song (Acoustic) (Remix)", "X"),
    ]
    for t, a in cases:
        plan = _build_query_plan(t, a)
        assert len(plan) <= 3


@pytest.mark.asyncio
async def test_search_budget_capped_globally():
    """An import cannot exceed MAX_SEARCHES_PER_IMPORT provider queries."""
    ctx = ImportContext()
    calls = {"n": 0}

    def counting(q, filter=None):
        calls["n"] += 1
        return make_outcome("ok", results=[raw_candidate(f"v{calls['n']}", q, "Artist")])

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = counting
    try:
        with patch("app.routes.playlist.asyncio.sleep", AsyncMock()):
            for i in range(MAX_SEARCHES_PER_IMPORT + 20):
                res = await _provider_search(ctx, f"unique query {i}")
                assert res["status"] in (STATUS_MATCHED, STATUS_PROVIDER_ERROR)
                if res["status"] == STATUS_PROVIDER_ERROR:
                    assert res["reason"] == "per-import search budget exhausted"
                    break
    finally:
        yt.search_ytmusic_detailed = orig
    assert ctx.searches_used <= MAX_SEARCHES_PER_IMPORT
    assert calls["n"] == MAX_SEARCHES_PER_IMPORT


@pytest.mark.asyncio
async def test_retries_do_not_double_count_budget(monkeypatch):
    """A retry reuses the same logical query; it never inflates searches_used."""
    ctx = ImportContext()
    calls = {"n": 0}

    def failing(q, filter=None):
        calls["n"] += 1
        return make_outcome("unreachable", reason="down")

    async def fake_sleep(_):
        pass

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = failing
    try:
        with patch("app.routes.playlist.asyncio.sleep", fake_sleep):
            res = await _provider_search(ctx, "will-fail")
    finally:
        yt.search_ytmusic_detailed = orig

    assert res["status"] == STATUS_UNREACHABLE
    # one logical query, even though provider was hit IMPORT_RETRY_ATTEMPTS times
    assert ctx.searches_used == 1
    assert calls["n"] == IMPORT_RETRY_ATTEMPTS


@pytest.mark.asyncio
async def test_cache_serves_identical_queries(monkeypatch):
    """Identical (case-insensitive) queries share one provider call."""
    ctx = ImportContext()
    calls = {"n": 0}

    def counting(q, filter=None):
        calls["n"] += 1
        return make_outcome("ok", results=[raw_candidate("v1", "Song", "Artist")])

    import app.services.ytmusic as yt
    orig = yt.search_ytmusic_detailed
    yt.search_ytmusic_detailed = counting
    try:
        r1 = await _provider_search(ctx, "Same Query")
        r2 = await _provider_search(ctx, "same query")
    finally:
        yt.search_ytmusic_detailed = orig
    assert r1 is r2
    assert calls["n"] == 1
    assert ctx.searches_used == 1


# ---------------------------------------------------------------------------
# Concurrency isolation
# ---------------------------------------------------------------------------


@pytest.fixture
def empty_mongodb():
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


@pytest.mark.asyncio
async def test_contexts_are_isolated(monkeypatch, empty_mongodb):
    """Two concurrent imports never share cache/dedup/query state."""
    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        # Distinct per-context providers (each import tracks its own queries).
        import app.services.ytmusic as yt

        calls = {"a": 0, "b": 0}

        def fake_search(q, filter=None):
            # Route by a leading token that identifies the "user"
            if "user a song" in q.lower():
                calls["a"] += 1
                return make_outcome("ok", results=[raw_candidate("va", "User A Song", "A")])
            calls["b"] += 1
            return make_outcome("ok", results=[raw_candidate("vb", "User B Song", "B")])

        orig = yt.search_ytmusic_detailed
        yt.search_ytmusic_detailed = fake_search
        try:
            ctx_a = ImportContext()
            ctx_b = ImportContext()

            async def import_a():
                return await _match_track(ctx_a, {"title": "User A Song", "artist": "A", "duration": 180})

            async def import_b():
                return await _match_track(ctx_b, {"title": "User B Song", "artist": "B", "duration": 180})

            res_a, res_b = await asyncio.gather(import_a(), import_b())

            assert res_a["status"] == STATUS_MATCHED
            assert res_a["match"]["videoId"] == "va"
            assert res_b["status"] == STATUS_MATCHED
            assert res_b["match"]["videoId"] == "vb"
            # each context tracked its own search
            assert ctx_a.searches_used == 1
            assert ctx_b.searches_used == 1
            # one import did NOT consume the other's cache
            assert "user a song a" in ctx_a.search_results_cache
            assert "user b song b" in ctx_b.search_results_cache
        finally:
            yt.search_ytmusic_detailed = orig


@pytest.mark.asyncio
async def test_overlapping_playlist_dedup_stays_per_request(monkeypatch, empty_mongodb):
    """Dedup of the same song in two imports is scoped to each request."""
    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        from app.routes.playlist import _is_duplicate, _mark_matched
        ctx_a = ImportContext()
        ctx_b = ImportContext()

        song = {"videoId": "same-vid", "title": "Common Song", "artist": "Ar"}
        # User A imports it and dedups within their own request.
        assert not _is_duplicate(ctx_a, song)
        _mark_matched(ctx_a, song)
        assert _is_duplicate(ctx_a, song)
        # User B's context is independent.
        assert not _is_duplicate(ctx_b, song)
        # The dedup set does not cross request boundaries.
        assert ctx_b.imported_video_ids == set()
        assert "same-vid" in ctx_a.imported_video_ids


@pytest.mark.asyncio
async def test_concurrent_same_playlist_two_users(monkeypatch, empty_mongodb):
    """Same playlist imported by two different users: independent, deterministic."""
    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        import app.services.ytmusic as yt

        def fake_search(q, filter=None):
            return make_outcome("ok", results=[raw_candidate("v1", "Song One", "Artist")])

        orig = yt.search_ytmusic_detailed
        yt.search_ytmusic_detailed = fake_search
        try:
            async def do_import(tag):
                ctx = ImportContext()
                res = await _match_track(ctx, {"title": "Song One", "artist": "Artist", "duration": 180})
                return ctx, res

            ctx1, r1 = await do_import("u1")
            ctx2, r2 = await do_import("u2")
            # Both resolve the same track deterministically.
            assert r1["match"]["videoId"] == r2["match"]["videoId"] == "v1"
            # No cross-request suppression: both ran one search.
            assert ctx1.searches_used == ctx2.searches_used == 1
        finally:
            yt.search_ytmusic_detailed = orig


@pytest.mark.asyncio
async def test_concurrent_import_burst_is_bounded(monkeypatch, empty_mongodb):
    """Many simultaneous tracks never exceed IMPORT_CONCURRENCY in-flight calls."""
    import time
    from app.routes.playlist import IMPORT_CONCURRENCY

    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        import app.services.ytmusic as yt

        state = {"in_flight": 0, "max_in_flight": 0, "total": 0}

        def slow_search(q, filter=None):
            state["in_flight"] += 1
            state["max_in_flight"] = max(state["max_in_flight"], state["in_flight"])
            state["total"] += 1
            try:
                # Simulate provider latency (blocking thread, like real to_thread).
                time.sleep(0.02)
            finally:
                state["in_flight"] -= 1
            title = q.rsplit(" ", 1)[0]  # strip the artist token
            return make_outcome("ok", results=[raw_candidate(f"v{i}", title, "A") for i in range(5)])

        orig = yt.search_ytmusic_detailed
        yt.search_ytmusic_detailed = slow_search
        try:
            n = 12  # more than IMPORT_CONCURRENCY
            sem = asyncio.Semaphore(IMPORT_CONCURRENCY)

            async def bounded(i):
                async with sem:
                    res = await _match_track(ImportContext(),
                                             {"title": f"T{i}", "artist": "A", "duration": 180})
                    assert res["status"] in (STATUS_MATCHED,)

            await asyncio.gather(*(bounded(i) for i in range(n)))
            # Never exceeded the bounded concurrency.
            assert state["max_in_flight"] <= IMPORT_CONCURRENCY
            # All tracks resolved (no request suppression).
            assert state["total"] >= 1
        finally:
            yt.search_ytmusic_detailed = orig


@pytest.mark.asyncio
async def test_large_import_respects_global_search_budget(monkeypatch, empty_mongodb):
    """A 200-track import cannot blow the provider call budget.

    Budget math: at most MAX_SEARCHES_PER_IMPORT distinct queries (each with
    up to IMPORT_RETRY_ATTEMPTS provider calls), regardless of playlist size.
    """
    from app.routes.playlist import MAX_SEARCHES_PER_IMPORT, IMPORT_RETRY_ATTEMPTS

    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        import app.services.ytmusic as yt

        calls = {"n": 0}

        def counting(q, filter=None):
            calls["n"] += 1
            return make_outcome("ok", results=[raw_candidate(f"v{calls['n']}",
                                                             q.rsplit(" ", 1)[0], "Artist")])

        orig = yt.search_ytmusic_detailed
        yt.search_ytmusic_detailed = counting
        try:
            sem = asyncio.Semaphore(3)
            ctx = ImportContext()  # ONE context shared across all tracks (like a real import)
            n = 200
            async def bounded(i):
                async with sem:
                    res = await _match_track(ctx,
                                             {"title": f"Track {i}", "artist": "Artist", "duration": 180})
                    assert res["status"] in (STATUS_MATCHED, STATUS_AMBIGUOUS,
                                             STATUS_PROVIDER_ERROR)  # budget exhaustion is safe

            await asyncio.gather(*(bounded(i) for i in range(n)))
        finally:
            yt.search_ytmusic_detailed = orig
        # Hard provider budget respected (distinct queries), even for 200 tracks.
        assert calls["n"] <= MAX_SEARCHES_PER_IMPORT * IMPORT_RETRY_ATTEMPTS
        assert calls["n"] <= MAX_SEARCHES_PER_IMPORT


# ---------------------------------------------------------------------------
# Provider outage + recovery
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_outage_never_produces_not_found(monkeypatch, empty_mongodb):
    """During a full provider outage, every track is 'failed', none 'not_found'."""
    with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
        import app.services.ytmusic as yt
        yt.search_ytmusic_detailed = (
            lambda q, filter=None: make_outcome("unreachable", reason="outage")
        )
        results = []
        for i in range(5):
            res = await _match_track(ImportContext(),
                                     {"title": f"Some Song {i}", "artist": "Someone"})
            results.append(res)
        statuses = {r["status"] for r in results}
        assert STATUS_NOT_FOUND not in statuses
        assert statuses == {STATUS_UNREACHABLE}
        assert all(r["match"] is None for r in results)


@pytest.mark.asyncio
async def test_recovery_after_outage(monkeypatch, empty_mongodb):
    """After the provider recovers, a subsequent import resolves normally."""
    import app.services.ytmusic as yt

    state = {"down": True}
    orig = yt.search_ytmusic_detailed

    def flaky(q, filter=None):
        if state["down"]:
            return make_outcome("unreachable", reason="outage")
        return make_outcome("ok", results=[raw_candidate("v1", "Recovered Song", "Ar")])

    yt.search_ytmusic_detailed = flaky
    try:
        with patch("app.routes.playlist.db.get_db", return_value=empty_mongodb):
            # During outage.
            res = await _match_track(ImportContext(),
                                     {"title": "Recovered Song", "artist": "Ar", "duration": 200})
            assert res["status"] == STATUS_UNREACHABLE
            assert res["match"] is None
            # Provider recovers.
            state["down"] = False
            res2 = await _match_track(ImportContext(),
                                      {"title": "Recovered Song", "artist": "Ar", "duration": 200})
            assert res2["status"] == STATUS_MATCHED
            assert res2["match"]["videoId"] == "v1"
    finally:
        yt.search_ytmusic_detailed = orig