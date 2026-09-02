"""
P2 regression tests: server-side canonical videoId validation

The backend must never trust browser-supplied (or otherwise externally
supplied) video IDs. The canonical YouTube video ID format is:

    ^[A-Za-z0-9_-]{11}$

Invalid IDs are rejected/dropped before they can become a matched song.

These tests cover ``is_valid_youtube_id`` (the shared strict predicate) and the
server trust boundary in the import pipeline: the ``_match_track`` Stage-1
exact-match gate. Endpoint-level coverage of the ``/import/resolve`` candidate
sanitizer (including "a rejected candidate does not block valid siblings")
lives in test_import_browser_assist.py.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.security import is_valid_youtube_id
from app.routes.playlist import ImportContext, _match_track, STATUS_MATCHED

VALID_ID = "dQw4w9WgXcQ"  # canonical Rick Astley (1987)


def make_outcome(status="ok", results=None, reason="ok"):
    return MagicMock(found=status == "ok" and bool(results), status=status,
                     reason=reason, results=results or [])


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


@pytest.fixture
def mock_db():
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
# is_valid_youtube_id (unit table)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [
    VALID_ID,                      # canonical 11-char id
    "  %s  " % VALID_ID,           # whitespace-wrapped -> stripped, accepted
    "not-a-video",                 # 11 chars of [A-Za-z0-9_-] -> shape-valid
    "-__________",                 # spans the allowed charset classes
])
def test_is_valid_youtube_id_accepts(value):
    assert is_valid_youtube_id(value) is True


@pytest.mark.parametrize("value", [
    "not-a-vide",                 # 10 chars -> too short
    "dQw4w9WgXcQa",               # 12 chars -> too long
    "not-a-video!",               # invalid character (!)
    "not a video",                # spaces are invalid
    "dQw4w9WgXc\u0000",           # NUL is not allowed
    "",                           # blank
    "   ",                        # whitespace only
    "abc123",                     # 6 chars (old lenient range) -> too short
    12345,                        # non-string
    None,                         # None
    ["dQw4w9WgXcQ"],              # non-string container
])
def test_is_valid_youtube_id_rejects(value):
    assert is_valid_youtube_id(value) is False


# ---------------------------------------------------------------------------
# Stage-1 exact-match gate: malformed ids can never produce an exact match
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_match_track_exact_gate_accepts_valid_id():
    ctx = ImportContext()
    res = await _match_track(ctx, {"title": "Song", "artist": "Artist", "videoId": VALID_ID})
    assert res["status"] == STATUS_MATCHED
    assert res["match_type"] == "exact"
    assert res["match"]["videoId"] == VALID_ID


@pytest.mark.asyncio
async def test_match_track_exact_gate_normalizes_whitespace_wrapped():
    """Whitespace-wrapped valid ids are accepted and persisted stripped."""
    ctx = ImportContext()
    res = await _match_track(ctx, {"title": "Song", "artist": "Artist", "videoId": "  %s  " % VALID_ID})
    assert res["status"] == STATUS_MATCHED
    assert res["match_type"] == "exact"
    assert res["match"]["videoId"] == VALID_ID


@pytest.mark.parametrize("bad_id", [
    "abc123",            # too short
    "not-a-vide",        # too short
    "dQw4w9WgXcQa",      # too long
    "not-a-video!",      # invalid char
    " ",                 # blank
    "",
    12345,               # non-string
])
@pytest.mark.asyncio
async def test_match_track_exact_gate_rejects_malformed_id(monkeypatch, mock_db, bad_id):
    """A malformed videoId must NOT short-circuit to an exact match. The track
    falls through to provider search instead, so a real id can be resolved."""
    with patch("app.routes.playlist.db.get_db", return_value=mock_db):
        ctx = ImportContext()
        monkeypatch.setattr(
            "app.services.ytmusic.search_ytmusic_detailed",
            lambda q, filter=None: make_outcome("ok", results=[raw_candidate("searchvid01", "Heer", "A R Rahman")]),
        )
        res = await _match_track(ctx, {"title": "Heer", "artist": "A R Rahman", "videoId": bad_id})
        assert res["status"] == STATUS_MATCHED
        assert res["match_type"] != "exact"
        assert res["match"]["videoId"] == "searchvid01"