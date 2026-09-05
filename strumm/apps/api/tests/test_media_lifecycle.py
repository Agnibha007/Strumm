"""
Lifecycle tests for unused B2 media expiration.

Covers the application-driven expiry path (B2 lifecycle rules can't express
"unused for N days"):

  * lastAccessedAt is stamped on upload, bumped on download/avatar access, and
    NOT bumped by metadata ops (confirm) or the cleanup job itself
  * candidates are media not accessed within MEDIA_UNUSED_RETENTION_DAYS
    (with a createdAt fallback for legacy records that predate the field)
  * referenced media (an active users.avatarMediaId) is never deleted
  * claims (cleanupClaimedUntil) make concurrent replicas safe and stale
    claims are reclaimed
  * every step is idempotent: B2 delete of a missing object is a no-op
    success, and a failure between B2 delete and record finalize self-heals
"""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from bson import ObjectId

from app.services import media_lifecycle as mlc
from app.services.storage import StorageError

OWNER = "507f1f77bcf86cd799439011"
_MISSING = object()


# ---------------------------------------------------------------------------
# Minimal query-aware fake collection
# ---------------------------------------------------------------------------


class FakeCollection:
    """In-memory collection supporting the small subset of Mongo query syntax
    the lifecycle code uses: equality, `$lt`, `$exists`, `$ne`, and `$or`."""

    def __init__(self, docs=None):
        self.docs = [dict(d) for d in (docs or [])]

    @staticmethod
    def _match(doc, query):
        for key, cond in query.items():
            actual = doc.get(key, _MISSING)
            if key == "$or":
                if not any(FakeCollection._match(doc, sub) for sub in cond):
                    return False
                continue
            if isinstance(cond, dict):
                if "$exists" in cond and (actual is _MISSING) == cond["$exists"]:
                    return False
                if "$lt" in cond and (actual is _MISSING or not (actual < cond["$lt"])):
                    return False
                if "$ne" in cond and actual is not _MISSING and actual == cond["$ne"]:
                    return False
                if not any(op in cond for op in ("$exists", "$lt", "$ne")):
                    if actual is _MISSING or actual != cond:
                        return False
                continue
            if key == "_id":
                if str(actual) != str(cond):
                    return False
            elif actual is _MISSING or actual != cond:
                return False
        return True

    def find(self, query):  # matches motor: returns a cursor, not a coroutine
        return _Cursor([dict(d) for d in self.docs if self._match(d, query)])

    async def find_one(self, query=None, *args, **kwargs):
        for doc in self.docs:
            if self._match(doc, query or {}):
                return dict(doc)
        return None

    async def update_one(self, query, update):
        for doc in self.docs:
            if self._match(doc, query):
                for key, value in update.get("$set", {}).items():
                    doc[key] = value
                for key in update.get("$unset", {}):
                    doc.pop(key, None)
                return MagicMock(modified_count=1)
        return MagicMock(modified_count=0)

    def get(self, media_id):
        for doc in self.docs:
            if str(doc.get("_id")) == str(media_id):
                return doc
        return None

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return MagicMock(inserted_id=doc.get("_id"))


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield d

        return gen()


def oid(n: int) -> ObjectId:
    """Deterministic valid ObjectId from a small integer."""
    return ObjectId(f"{n if n >= 0 else 0:024x}")


def make_record(media_id, *, last_accessed=None, created=None, **overrides):
    now = datetime.utcnow()
    _id = media_id if isinstance(media_id, ObjectId) else oid(media_id)
    rec = {
        "_id": _id,
        "ownerId": OWNER,
        "category": "avatar",
        "objectKey": f"users/{OWNER}/avatar/{str(_id)[:12]}-av.png",
        "mime": "image/png",
        "filename": "av.png",
        "size": 1000,
        "status": "ready",
        "createdAt": created or (now - timedelta(days=30)),
        "updatedAt": now,
        "deletedAt": None,
    }
    if last_accessed is not None:
        rec["lastAccessedAt"] = last_accessed
    rec.update(overrides)
    return rec


@pytest.fixture
def db():
    fakemedia = FakeCollection()
    fakeusers = FakeCollection()
    fakedb = MagicMock()
    fakedb.MEDIA = "media"
    fakedb.USERS = "users"
    fakedb.__getitem__.side_effect = lambda name: {"media": fakemedia, "users": fakeusers}[name]
    return fakedb, fakemedia, fakeusers


def enable_storage(monkeypatch, delete_side_effect=None):
    monkeypatch.setattr(mlc.storage, "storage_enabled", lambda: True)
    monkeypatch.setattr(mlc.storage, "delete_object", MagicMock(side_effect=delete_side_effect or (lambda k: None)))


# ---------------------------------------------------------------------------
# Candidate selection
# ---------------------------------------------------------------------------


async def test_fresh_media_not_expired(monkeypatch, db):
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=1)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 0
    mlc.storage.delete_object.assert_not_called()
    assert fakemedia.get(oid(1))["deletedAt"] is None


async def test_unused_recently_but_created_ages_ago_not_deleted(monkeypatch, db):
    """A record accessed yesterday must survive no matter how old it is."""
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(
        1,
        created=datetime.utcnow() - timedelta(days=400),
        last_accessed=datetime.utcnow() - timedelta(days=1),
    ))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 0
    mlc.storage.delete_object.assert_not_called()


async def test_stale_media_is_deleted(monkeypatch, db):
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    mlc.storage.delete_object.assert_called_once_with(f"users/{OWNER}/avatar/{str(oid(1))[:12]}-av.png")
    rec = fakemedia.get(oid(1))
    assert rec["status"] == "deleted"
    assert rec["deletedAt"] is not None


async def test_legacy_record_without_last_accessed_uses_created_at(monkeypatch, db):
    """Records created before lastAccessedAt existed fall back to createdAt."""
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    now = datetime.utcnow()
    fakemedia.docs.append(make_record(1, created=now - timedelta(days=30)))  # no lastAccessedAt
    fakemedia.docs.append(make_record(2, created=now - timedelta(days=1)))   # no lastAccessedAt

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    assert fakemedia.get(oid(1))["status"] == "deleted"
    assert fakemedia.get(oid(2))["deletedAt"] is None


async def test_boundary_at_cutoff(monkeypatch, db):
    """Exactly retention-days of quiet is expired; a single second newer is not."""
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    now = datetime.utcnow()
    cutoff = now - timedelta(days=mlc.MEDIA_UNUSED_RETENTION_DAYS)
    fakemedia.docs.append(make_record(1, last_accessed=cutoff - timedelta(seconds=1)))
    fakemedia.docs.append(make_record(2, last_accessed=cutoff + timedelta(seconds=1)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    assert fakemedia.get(oid(1))["status"] == "deleted"
    assert fakemedia.get(oid(2))["deletedAt"] is None


# ---------------------------------------------------------------------------
# Reference protection
# ---------------------------------------------------------------------------


async def test_referenced_active_avatar_never_deleted(monkeypatch, db):
    fakedb, fakemedia, fakeusers = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))
    fakeusers.docs.append({"_id": ObjectId(OWNER), "avatarMediaId": str(oid(1))})

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["referenced"] == 1
    mlc.storage.delete_object.assert_not_called()
    assert fakemedia.get(oid(1))["deletedAt"] is None
    # the shielding record is no longer claimed after the reference check
    assert "cleanupClaimedUntil" not in fakemedia.get(oid(1))


async def test_unreferenced_stale_record_deleted_even_if_legacy_ref_missing(monkeypatch, db):
    fakedb, fakemedia, fakeusers = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(2, last_accessed=datetime.utcnow() - timedelta(days=10)))
    fakeusers.docs.append({"_id": ObjectId("000000000000000000000000"), "avatarMediaId": "other"})

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    assert fakemedia.get(oid(2))["status"] == "deleted"


# ---------------------------------------------------------------------------
# Concurrency / claims
# ---------------------------------------------------------------------------


async def test_claimed_by_another_worker_is_skipped(monkeypatch, db):
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    future = datetime.utcnow() + timedelta(minutes=10)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10),
                                      cleanupClaimedUntil=future))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["skipped"] == 1
    mlc.storage.delete_object.assert_not_called()


async def test_stale_claim_is_reclaimed(monkeypatch, db):
    """A crashed worker's expired claim does not strand the record forever."""
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    stale_claim = datetime.utcnow() - timedelta(hours=2)  # older than any claim TTL
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10),
                                      cleanupClaimedUntil=stale_claim))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    assert fakemedia.get(oid(1))["status"] == "deleted"


# ---------------------------------------------------------------------------
# Failure recovery / idempotency
# ---------------------------------------------------------------------------


async def test_delete_object_failure_releases_claim_and_keeps_record(monkeypatch, db):
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch, delete_side_effect=StorageError("boom"))
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["errors"] == 1
    assert stats["deleted"] == 0
    rec = fakemedia.get(oid(1))
    assert rec["deletedAt"] is None
    # claim released so the next pass can retry
    assert "cleanupClaimedUntil" not in rec


async def test_missing_object_is_a_success(monkeypatch, db):
    """If the record survived but the B2 object is already gone, cleanup still
    finalizes the record instead of erroring forever."""
    fakedb, fakemedia, _ = db

    def delete_noop(key):
        return None  # B2 DELETE of a missing object succeeds (idempotent)

    enable_storage(monkeypatch, delete_side_effect=delete_noop)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["deleted"] == 1
    assert fakemedia.get(oid(1))["status"] == "deleted"


async def test_cleanup_is_noop_when_storage_disabled(monkeypatch, db):
    fakedb, fakemedia, _ = db
    monkeypatch.setattr(mlc.storage, "storage_enabled", lambda: False)
    delete_mock = MagicMock()
    monkeypatch.setattr(mlc.storage, "delete_object", delete_mock)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))

    stats = await mlc.cleanup_expired_media(fakedb)

    assert stats["skipped"] == 1
    delete_mock.assert_not_called()


async def test_retry_after_partial_failure_finishes_the_job(monkeypatch, db):
    """B2 deleted, then record-finalize throws -> next pass finalizes it."""
    fakedb, fakemedia, _ = db
    enable_storage(monkeypatch)
    fakemedia.docs.append(make_record(1, last_accessed=datetime.utcnow() - timedelta(days=10)))

    # First pass fails between B2 delete and record finalize.
    real_update_one = fakemedia.update_one
    calls = {"n": 0}

    async def flaky_update(query, update):
        calls["n"] += 1
        if "deletedAt" in update.get("$set", {}):
            # This is the finalize call; simulate a Mongo network failure. The
            # later claim *release* still works, so the next pass can retry.
            raise RuntimeError("connection reset")
        return await real_update_one(query, update)

    fakemedia.update_one = flaky_update
    stats1 = await mlc.cleanup_expired_media(fakedb)
    assert stats1["errors"] == 1
    mlc.storage.delete_object.assert_called_once()
    assert fakemedia.get(oid(1))["deletedAt"] is None

    # Second pass: B2 delete re-runs (no-op success) and finalize completes.
    fakemedia.update_one = real_update_one
    stats2 = await mlc.cleanup_expired_media(fakedb)
    assert stats2["deleted"] == 1
    assert fakemedia.get(oid(1))["status"] == "deleted"


# ---------------------------------------------------------------------------
# mark_media_accessed (access tracking boundary)
# ---------------------------------------------------------------------------


async def test_mark_accessed_sets_last_accessed_at(db):
    fakedb, fakemedia, _ = db
    old = datetime(2020, 1, 1)
    fakemedia.docs.append(make_record(1, last_accessed=old))

    await mlc.mark_media_accessed(fakedb, fakemedia.get(oid(1)))

    assert fakemedia.get(oid(1))["lastAccessedAt"] > old


async def test_mark_accessed_does_not_update_soft_deleted_record(db):
    fakedb, fakemedia, _ = db
    old = datetime(2020, 1, 1)
    fakemedia.docs.append(make_record(1, last_accessed=old, deletedAt=datetime.utcnow()))

    await mlc.mark_media_accessed(fakedb, fakemedia.get(oid(1)))

    assert fakemedia.get(oid(1))["lastAccessedAt"] == old


async def test_mark_accessed_swallows_database_errors(db):
    fakedb, fakemedia, _ = db
    fakebad = MagicMock()
    fakebad.__getitem__.side_effect = RuntimeError("down")
    # must not raise — access tracking is best-effort only
    await mlc.mark_media_accessed(fakebad, {"_id": "x", "deletedAt": None})


# ---------------------------------------------------------------------------
# Route-level: lastAccessedAt behavior on access/metadata boundaries
# ---------------------------------------------------------------------------


def make_client(media_records=None, monkeypatch=None):
    fakemedia = FakeCollection(media_records)
    fakedb = MagicMock()
    fakedb.MEDIA = "media"
    fakedb.USERS = "users"
    fakedb.__getitem__.side_effect = lambda name: fakemedia if name == "media" else MagicMock()

    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=fakedb)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user
    import app.routes.media as media_mod

    async def mock_user():
        return {"id": OWNER, "username": "owner", "email": "o@example.com"}

    _app.dependency_overrides[get_current_user] = mock_user

    fake = MagicMock()
    fake.get_presigned_url.return_value = "https://s3.example/key?X-Amz-Signature=zzz"
    if monkeypatch is not None:
        monkeypatch.setattr("app.services.storage._get_client", lambda: fake)
    else:
        media_mod.storage._get_client = lambda: fake

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test"), fakemedia


async def test_upload_url_stamps_last_accessed_at_on_new_media(monkeypatch):
    client, fakemedia = make_client(monkeypatch=monkeypatch)

    resp = await client.post("/media/upload-url", json={
        "category": "avatar", "filename": "me.png", "contentType": "image/png", "size": 1000,
    })
    assert resp.status_code == 200
    assert len(fakemedia.docs) == 1
    stamped = fakemedia.docs[0].get("lastAccessedAt")
    assert stamped is not None
    assert datetime.utcnow() - stamped < timedelta(minutes=1)
    await client.aclose()


async def test_confirm_does_not_bump_last_accessed_at(monkeypatch):
    created = datetime(2020, 5, 5)
    client, fakemedia = make_client([make_record(
        30, last_accessed=created, created=created, status="pending",
    )], monkeypatch=monkeypatch)

    resp = await client.post("/media/confirm", json={"mediaId": str(oid(30))})
    assert resp.status_code == 200
    assert fakemedia.get(oid(30))["lastAccessedAt"] == created  # metadata op: no bump
    await client.aclose()


async def test_download_url_bumps_last_accessed_at(monkeypatch):
    old = datetime(2020, 1, 1)
    client, fakemedia = make_client([make_record(31, last_accessed=old)], monkeypatch=monkeypatch)

    resp = await client.get("/media/download-url",
                            params={"key": f"users/{OWNER}/avatar/{str(oid(31))[:12]}-av.png"})
    assert resp.status_code == 200
    assert fakemedia.get(oid(31))["lastAccessedAt"] > old
    await client.aclose()


async def test_avatar_url_bumps_last_accessed_at(monkeypatch):
    old = datetime(2020, 1, 1)
    client, fakemedia = make_client([make_record(32, last_accessed=old)], monkeypatch=monkeypatch)

    resp = await client.get("/media/avatar-url", params={"mediaId": str(oid(32))})
    assert resp.status_code == 200
    assert fakemedia.get(oid(32))["lastAccessedAt"] > old
    await client.aclose()