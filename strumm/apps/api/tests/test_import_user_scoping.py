"""
P1 regression tests: Stage-2 local-library matching must be scoped to the
CURRENT authenticated user.

Regression target: ``_match_track`` Stage 2 scanned the entire LIKED_SONGS and
PLAYLISTS collections with an EMPTY MongoDB filter ({}), so any authenticated
user's import could (a) oracle-probe other users' private libraries through
fuzzy title+artist matches and (b) harvest a videoId from another user's
private playlist into their own.

These tests assert the ACTUAL Mongo query filters emitted by the pipeline are
user-scoped, and that a user can select their own library but never another
user's. A filter-aware fake DB is used (not an always-empty cursor) so a
regression back to the unscoped {} scan fails loudly.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from bson import ObjectId

from app.database import mongodb as real_db
from app.routes.playlist import ImportContext, _match_track, _run_import_pipeline, STATUS_MATCHED, STATUS_NOT_FOUND

USER_A = "aaaaaaaaaaaaaaaaaaaaaaaa"  # 24-hex ObjectId
USER_B = "bbbbbbbbbbbbbbbbbbbbbbbb"
USER_C = "cccccccccccccccccccccccc"
USER_B_OID = ObjectId(USER_B)

VID_A = "aaaaaaaaaaa"
VID_B = "bbbbbbbbbbb"
VID_C = "ccccccccccc"


def make_outcome(status="ok", results=None, reason="no results"):
    return MagicMock(found=status == "ok" and bool(results), status=status,
                     reason=reason, results=results or [])


class FakeCollection:
    """Minimal Mongo collection that applies a SUBSET of Mongo semantics for
    the exact query shapes the pipeline emits, and records every filter it
    receives so tests can assert scoping."""

    def __init__(self, name, docs=None):
        self.name = name
        self.docs = docs or []
        self.find_filters = []
        self.insert_one = AsyncMock()

    @staticmethod
    def _norm(v):
        return str(v)

    @classmethod
    def _id_in(cls, doc, ids):
        doc_uid = cls._norm(doc.get("userId", ""))
        return any(cls._norm(i) == doc_uid for i in ids)

    def _match(self, doc, query):
        if "$or" in query:
            return any(self._match(doc, clause) for clause in query["$or"])
        if "userId" in query:
            return self._id_in(doc, query["userId"]["$in"])
        if "collaborators" in query:
            collabs = doc.get("collaborators") or []
            return any(self._norm(c) == self._norm(query["collaborators"]) for c in collabs)
        return False

    def find(self, query, projection=None):
        self.find_filters.append(query)
        matched = [d for d in self.docs if self._match(d, query)]
        cur = AsyncMock()
        cur.__aiter__.return_value = iter(matched)
        return cur


class FakeDB:
    def __init__(self, likes=None, playlists=None):
        self._cols = {
            real_db.LIKED_SONGS: FakeCollection(real_db.LIKED_SONGS, likes or []),
            real_db.PLAYLISTS: FakeCollection(real_db.PLAYLISTS, playlists or []),
        }

    def __getitem__(self, name):
        return self._cols[name]


def build_db(likes=None, playlists=None):
    db = FakeDB(likes=likes, playlists=playlists)
    patcher = patch("app.routes.playlist.db.get_db", return_value=db)
    return db, patcher


def like(user_id, video_id, title, artist):
    return {"userId": user_id, "song": {"videoId": video_id, "title": title, "artist": artist}}


def playlist(user_id, video_id, title, artist, collaborators=None):
    return {
        "userId": user_id,
        "songs": [{"videoId": video_id, "title": title, "artist": artist}],
        "collaborators": collaborators or [],
    }


def _assert_liked_filters_scoped_to(db, user_id_str, user_id_oid):
    liked = db[real_db.LIKED_SONGS]
    assert liked.find_filters, "Stage 2 must query LIKED_SONGS"
    for f in liked.find_filters:
        assert "userId" in f, "liked-songs filter must be userId-scoped"
        ids = [str(x) for x in f["userId"]["$in"]]
        assert len(ids) >= 1
        assert ids == [user_id_str, str(user_id_oid)] or ids == [user_id_str], \
            f"liked filter must only contain the current user's ids, got {ids}"
        assert not any(x in ids for x in (USER_A, USER_C)), \
            f"liked filter must not include other users, got {ids}"


def _assert_playlist_filters_scoped_to(db, user_id_str, user_id_oid):
    playlists = db[real_db.PLAYLISTS]
    assert playlists.find_filters, "Stage 2 must query PLAYLISTS"
    for f in playlists.find_filters:
        assert "$or" in f, "playlist filter must use the owner-or-collaborator shape"
        assert len(f["$or"]) == 2
        owner, collab = f["$or"]
        assert "userId" in owner, "owner clause must be userId-scoped"
        owner_ids = [str(x) for x in owner["userId"]["$in"]]
        assert not any(x in owner_ids for x in (USER_A, USER_C)), \
            f"owner clause must not include other users, got {owner_ids}"
        assert collab == {"collaborators": user_id_str}


@pytest.mark.asyncio
async def test_stage2_cannot_select_other_users_song():
    """User A has a strongly matching liked song + playlist entry. User B
    imports the same track and must NOT be able to select A's song/id."""
    db, patcher = build_db(
        likes=[like(USER_A, VID_A, "Heer", "A R Rahman")],
        playlists=[playlist(USER_A, VID_A, "Heer", "A R Rahman")],
    )
    with patcher:
        ctx = ImportContext(user_id=USER_B)
        with patch("app.services.ytmusic.search_ytmusic_detailed",
                   return_value=make_outcome("ok", results=[])):
            res = await _match_track(ctx, {"title": "Heer", "artist": "A R Rahman"})

    # A's song resolve to nothing for B: no match, definitely not A's videoId.
    assert res["status"] == STATUS_NOT_FOUND
    assert res["match"] is None

    # The actual Mongo filters were user-scoped (only B), not an unscoped {}.
    _assert_liked_filters_scoped_to(db, USER_B, USER_B_OID)
    _assert_playlist_filters_scoped_to(db, USER_B, USER_B_OID)


@pytest.mark.asyncio
async def test_stage2_can_select_own_liked_song():
    """Positive control: B's OWN liked song with the same title/artist can be
    matched — and A's identical entry is ignored in favour of B's."""
    db, patcher = build_db(
        likes=[
            like(USER_A, VID_A, "Heer", "A R Rahman"),
            like(USER_B, VID_B, "Heer", "A R Rahman"),
        ],
        playlists=[playlist(USER_A, VID_A, "Heer", "A R Rahman")],
    )
    with patcher:
        ctx = ImportContext(user_id=USER_B)
        with patch("app.services.ytmusic.search_ytmusic_detailed",
                   return_value=make_outcome("ok", results=[])):
            res = await _match_track(ctx, {"title": "Heer", "artist": "A R Rahman"})

    assert res["status"] == STATUS_MATCHED
    assert res["match"]["videoId"] == VID_B  # B's own id, never A's


@pytest.mark.asyncio
async def test_stage2_picks_playlist_user_collaborates_on():
    """A playlist owned by A but with B as a collaborator is readable by B
    (existing collaboration semantics preserved)."""
    shared = {"userId": USER_A, "collaborators": [USER_B],
              "songs": [{"videoId": VID_B, "title": "Heer", "artist": "A R Rahman"}]}
    db, patcher = build_db(likes=[], playlists=[shared])
    with patcher:
        ctx = ImportContext(user_id=USER_B)
        with patch("app.services.ytmusic.search_ytmusic_detailed",
                   return_value=make_outcome("ok", results=[])):
            res = await _match_track(ctx, {"title": "Heer", "artist": "A R Rahman"})

    assert res["status"] == STATUS_MATCHED
    assert res["match"]["videoId"] == VID_B
    _assert_playlist_filters_scoped_to(db, USER_B, USER_B_OID)


@pytest.mark.asyncio
async def test_stage2_ignores_playlist_not_owned_or_shared():
    """A playlist neither owned nor shared with B must never influence B's
    match — even though it contains a perfect title/artist match."""
    priv = {"userId": USER_C, "collaborators": [],
            "songs": [{"videoId": VID_C, "title": "Heer", "artist": "A R Rahman"}]}
    db, patcher = build_db(likes=[], playlists=[priv])
    with patcher:
        ctx = ImportContext(user_id=USER_B)
        with patch("app.services.ytmusic.search_ytmusic_detailed",
                   return_value=make_outcome("ok", results=[])):
            res = await _match_track(ctx, {"title": "Heer", "artist": "A R Rahman"})

    assert res["status"] == STATUS_NOT_FOUND
    assert res["match"] is None
    _assert_liked_filters_scoped_to(db, USER_B, USER_B_OID)
    _assert_playlist_filters_scoped_to(db, USER_B, USER_B_OID)


@pytest.mark.asyncio
async def test_import_pipeline_persists_only_own_library_song():
    """End-to-end: User B imports a track; the persisted playlist contains
    only B's own library match, never User A's harvested videoId."""
    db, patcher = build_db(
        likes=[
            like(USER_A, VID_A, "Heer", "A R Rahman"),
            like(USER_B, VID_B, "Heer", "A R Rahman"),
        ],
        playlists=[playlist(USER_A, VID_A, "Heer", "A R Rahman")],
    )
    with patcher:
        ctx = ImportContext()
        with patch("app.services.ytmusic.search_ytmusic_detailed",
                   return_value=make_outcome("ok", results=[])):
            result = await _run_import_pipeline(
                ctx,
                [{"title": "Heer", "artist": "A R Rahman", "album": ""}],
                user_id=USER_B,
                source="csv",
                import_name="Test",
            )

    data = result["data"]
    persisted_ids = {s["videoId"] for s in data["matched"] + data["similar_matches"]}
    assert persisted_ids == {VID_B}
    assert VID_A not in persisted_ids

    inserted = db[real_db.PLAYLISTS].insert_one.await_args.args[0]
    assert {s["videoId"] for s in inserted["songs"]} == {VID_B}