"""Tests for the B2-backed avatar migration: media resolution, authorization,
and the /profile avatarMediaId flow. Self-contained (no external fixtures)."""

import pytest
from datetime import datetime
from bson import ObjectId
from unittest.mock import AsyncMock, MagicMock, patch


MEDIA_ID = "64b2e4a99c8a2c3d5e6f7081"
OTHER_MEDIA_ID = "64b2e4a99c8a2c3d5e6f7099"
OWNER_ID = "507f1f77bcf86cd799439011"
OBJECT_KEY = f"users/{OWNER_ID}/avatar/{'a' * 32}-me.png"
SIGNED_URL = "https://b2/signed?X-Amz-Signature=abc"


def make_media_record(_id=None, **overrides):
    rec = {
        "_id": ObjectId(_id or MEDIA_ID),
        "ownerId": OWNER_ID,
        "category": "avatar",
        "objectKey": OBJECT_KEY,
        "mime": "image/png",
        "filename": "me.png",
        "size": 1000,
        "status": "ready",
        "createdAt": datetime.utcnow(),
        "updatedAt": datetime.utcnow(),
        "deletedAt": None,
    }
    rec.update(overrides)
    return rec


def make_user_doc(**overrides):
    doc = {
        "_id": ObjectId(OWNER_ID),
        "username": "testuser",
        "displayName": "Test",
        "email": "t@example.com",
        "createdAt": datetime.utcnow(),
    }
    doc.update(overrides)
    return doc


def _collection(records):
    items = list(records)

    async def find_one(query=None):
        q = query or {}
        for doc in items:
            ok = True
            for key, expect in q.items():
                if key == "_id":
                    if str(doc.get("_id")) != str(expect):
                        ok = False
                        break
                elif key == "deletedAt" and expect is None:
                    if doc.get(key) is not None:
                        ok = False
                        break
                elif doc.get(key) != expect:
                    ok = False
                    break
            if ok:
                return dict(doc)
        return None

    async def update_one(query, update):
        for doc in items:
            if str(doc.get("_id")) == str(query.get("_id")):
                doc.update(update.get("$set", {}))
        return MagicMock()

    async def insert_one(doc):
        items.append(doc)
        return MagicMock()

    collection = MagicMock()
    collection.find_one = AsyncMock(side_effect=find_one)
    collection.update_one = AsyncMock(side_effect=update_one)
    collection.insert_one = AsyncMock(side_effect=insert_one)
    return collection


def stub_db(users=None, media=None):
    """Route db collection access to fake users/media collections + mock storage client."""
    from app.database import mongodb
    users_col = _collection(users or [])
    media_col = _collection(media if media is not None else [])

    def _getitem(name):
        if name == "users":
            return users_col
        return media_col

    fake_db = MagicMock()
    fake_db.USERS = "users"
    fake_db.MEDIA = "media"
    fake_db.__getitem__.side_effect = _getitem
    mongodb.get_db = MagicMock(return_value=fake_db)
    return fake_db, users_col, media_col


def make_client(current_user):
    """Build an AsyncClient against the FastAPI app with auth overridden."""
    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    async def mock_get_current_user():
        return dict(current_user)

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


CURRENT_USER = {
    "id": OWNER_ID,
    "username": "testuser",
    "displayName": "Test",
    "email": "t@example.com",
}


def setup_storage(monkeypatch, *, delete_called=None):
    import app.routes.media as media_mod
    import app.services.storage as storage_mod
    import app.services.avatar as avatar_mod
    fake_storage = MagicMock()
    fake_storage.create_download_url.return_value = {
        "downloadUrl": SIGNED_URL,
        "expiresIn": 900,
    }
    fake_storage.delete_object = MagicMock()
    monkeypatch.setattr(media_mod, "storage", fake_storage)
    # _soft_delete_avatar_media imports storage at call time
    monkeypatch.setattr(storage_mod, "delete_object", fake_storage.delete_object)
    # avatar resolver reads app.services.storage.create_download_url
    monkeypatch.setattr(avatar_mod.storage, "create_download_url", fake_storage.create_download_url)
    return fake_storage


# ---------------------------------------------------------------------------
# app.services.avatar resolution (pure, no route)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_decorate_legacy_avatar_unchanged():
    stub_db()
    from app.services.avatar import decorate_user_avatar

    user = {"id": "u1", "avatar": "data:image/png;base64,AAAA"}
    result = await decorate_user_avatar(user)
    assert result["avatar"] == "data:image/png;base64,AAAA"
    assert "avatarMediaId" not in result
    assert "avatarExpiresIn" not in result


@pytest.mark.asyncio
async def test_decorate_b2_avatar_returns_signed_url(monkeypatch):
    stub_db(media=[make_media_record()])
    fake_avatar_storage = MagicMock()
    fake_avatar_storage.create_download_url.return_value = {"downloadUrl": SIGNED_URL, "expiresIn": 900}
    monkeypatch.setattr("app.services.avatar.storage", fake_avatar_storage)
    from app.services.avatar import resolve_avatar_url

    url = await resolve_avatar_url(MEDIA_ID, None)
    assert url == SIGNED_URL
    assert "X-Amz-Signature" in url


@pytest.mark.asyncio
async def test_resolve_avatar_missing_record_falls_back_to_legacy():
    stub_db(media=[])
    from app.services.avatar import resolve_avatar_url

    url = await resolve_avatar_url(MEDIA_ID, "data:image/png;base64,BB")
    assert url == "data:image/png;base64,BB"


@pytest.mark.asyncio
async def test_resolve_avatar_not_ready_falls_back():
    stub_db(media=[make_media_record(status="pending")])
    from app.services.avatar import resolve_avatar_url

    assert await resolve_avatar_url(MEDIA_ID, "data:image/png;base64,CC") == "data:image/png;base64,CC"


@pytest.mark.asyncio
async def test_resolve_avatar_deleted_record_returns_none():
    stub_db(media=[make_media_record(deletedAt=datetime.utcnow())])
    from app.services.avatar import resolve_avatar_url

    assert await resolve_avatar_url(MEDIA_ID, None) is None


# ---------------------------------------------------------------------------
# GET /media/avatar-url authorization
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_avatar_url_authorizes_owner(monkeypatch):
    stub_db(media=[make_media_record()])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.get(f"/media/avatar-url?mediaId={MEDIA_ID}")
    assert res.status_code == 200
    assert res.json()["data"]["url"] == SIGNED_URL
    await client.aclose()


@pytest.mark.asyncio
async def test_avatar_url_forbidden_for_other_owner(monkeypatch):
    stub_db(media=[make_media_record(ownerId="anotheruser123456789abcdef0")])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.get(f"/media/avatar-url?mediaId={MEDIA_ID}")
    assert res.status_code == 403
    await client.aclose()


@pytest.mark.asyncio
async def test_avatar_url_missing_returns_404(monkeypatch):
    stub_db(media=[])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.get(f"/media/avatar-url?mediaId={MEDIA_ID}")
    assert res.status_code == 404
    await client.aclose()


@pytest.mark.asyncio
async def test_avatar_url_not_ready_returns_400(monkeypatch):
    stub_db(media=[make_media_record(status="pending")])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.get(f"/media/avatar-url?mediaId={MEDIA_ID}")
    assert res.status_code == 400
    await client.aclose()


# ---------------------------------------------------------------------------
# PATCH /profile with avatarMediaId
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_profile_accepts_avatar_media_id(monkeypatch):
    stub_db(
        users=[make_user_doc(avatarMediaId=OTHER_MEDIA_ID)],
        # new + old media records both belong to the current user and are ready
        media=[
            make_media_record(_id=MEDIA_ID, objectKey=f"users/{OWNER_ID}/avatar/{'c' * 32}-new.png"),
            make_media_record(_id=OTHER_MEDIA_ID, objectKey=f"users/{OWNER_ID}/avatar/{'b' * 32}-old.png"),
        ],
    )
    fake_storage = setup_storage(monkeypatch)
    # current user previously had a B2 avatar
    current_user = dict(CURRENT_USER)
    current_user["avatarMediaId"] = OTHER_MEDIA_ID
    client = make_client(current_user)

    res = await client.patch("/profile", json={"avatarMediaId": MEDIA_ID})
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    data = body["data"]
    assert data["avatarMediaId"] == MEDIA_ID
    # legacy base64 cleared; avatar decoded to a fresh signed URL
    assert data["avatar"] == SIGNED_URL
    # old B2 object is removed only AFTER the reference swap
    assert fake_storage.delete_object.called
    await client.aclose()


@pytest.mark.asyncio
async def test_patch_profile_rejects_unknown_avatar_media(monkeypatch):
    stub_db(users=[make_user_doc()], media=[])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.patch("/profile", json={"avatarMediaId": MEDIA_ID})
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is False
    assert body["error"] == "Avatar media was not found or is not ready."
    await client.aclose()


@pytest.mark.asyncio
async def test_patch_profile_rejects_media_not_owned(monkeypatch):
    stub_db(users=[make_user_doc()], media=[make_media_record(ownerId="someoneelse123456789abcdef0")])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.patch("/profile", json={"avatarMediaId": MEDIA_ID})
    assert res.json()["success"] is False
    await client.aclose()


@pytest.mark.asyncio
async def test_patch_profile_legacy_avatar_still_works(monkeypatch):
    stub_db(users=[make_user_doc()], media=[])
    setup_storage(monkeypatch)
    client = make_client(CURRENT_USER)

    res = await client.patch("/profile", json={"avatar": "data:image/png;base64,NEW"})
    assert res.status_code == 200
    assert res.json()["success"] is True
    await client.aclose()