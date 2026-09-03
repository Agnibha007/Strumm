"""Tests for the Backblaze B2 object-storage service and /media endpoints.

Covers:
    * B2 configuration / enabled detection
    * object-key building + filename sanitization
    * per-category MIME/size validation (invalid file types / sizes)
    * presigned upload-URL generation (mocked client)
    * authorization before issuing upload / download / delete
    * ownership checks (a user cannot access another user's object)
    * deletion authorization
    * presigned URL must not leak the application key

The MinIO client is faked; these tests never touch real B2.
"""

from __future__ import annotations

import re
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services import storage
from app.services.storage import (
    CATEGORIES,
    StorageError,
    StorageUnavailableError,
    StorageValidationError,
    build_object_key,
    create_upload_url,
    create_download_url,
    delete_object,
    object_exists,
    sanitize_filename,
    validate_category,
    validate_mime,
    validate_size,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def fake_media_collection(records: list[dict] | None = None):
    """Return a mock 'media' collection whose find_one is filter-aware for
    objectKey/ownerId, matching the route's authorization lookups."""
    items = list(records or [])

    def _match(document, query):
        for key, expect in query.items():
            actual = document.get(key)
            if key == "deletedAt" and expect is None:
                if actual is not None:
                    return False
                continue
            # ObjectIds are compared by their string form for convenience.
            if key == "_id":
                if str(actual) != str(expect):
                    return False
                continue
            if actual != expect:
                return False
        return True

    collection = MagicMock()
    found = {}

    async def find_one(query=None):
        for doc in items:
            if _match(doc, query or {}):
                # Return a shallow copy so tests can assert on result ids
                result = dict(doc)
                return result
        return None

    collection.find_one = AsyncMock(side_effect=find_one)

    async def insert_one(doc):
        items.append(doc)
        return MagicMock(inserted_id=doc["_id"])

    collection.insert_one = AsyncMock(side_effect=insert_one)

    async def update_one(query, update):
        target = None
        for doc in items:
            k = list(query.keys())[0]
            if doc.get(k) == query[k]:
                target = doc
                break
        if target is not None:
            target.update(update.get("$set", {}))
        return MagicMock()

    collection.update_one = AsyncMock(side_effect=update_one)
    return collection


def make_db(records: list[dict] | None = None):
    """Return a stub database object whose collection access returns the fake
    media collection. MagicMock __getitem__/__setitem__ do not interoperate, so
    __getitem__ is routed explicitly for the media collection."""
    db = MagicMock()
    db.USERS = "users"
    db.MEDIA = "media"
    media_collection = fake_media_collection(records)

    def _getitem(name):
        return media_collection if name == db.MEDIA else MagicMock()

    db.__getitem__.side_effect = _getitem
    return db


def make_client(records: list[dict] | None = None):
    """Build an AsyncClient with a stubbed db seeded with the given media
    records, mocked auth, and a mocked storage client."""
    from unittest.mock import AsyncMock as _AsyncMock, MagicMock as _MagicMock

    from app.database import mongodb
    mongodb.get_db = _MagicMock(return_value=make_db(records))

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    current_user = {
        "id": "507f1f77bcf86cd799439011",
        "username": "testuser",
        "email": "test@example.com",
        "createdAt": "2025-01-01T00:00:00",
    }

    async def mock_get_current_user():
        return dict(current_user)

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


@pytest.fixture
def mock_db():
    """Stub database returning an empty fake media collection."""
    return make_db()


@pytest.fixture
def client(mock_db):
    """AsyncClient against the FastAPI app with auth + DB + storage mocked."""
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=mock_db)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    current_user = {
        "id": "507f1f77bcf86cd799439011",
        "username": "testuser",
        "email": "test@example.com",
        "createdAt": "2025-01-01T00:00:00",
    }

    async def mock_get_current_user():
        return dict(current_user)

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=_app), base_url="http://test")


# ---------------------------------------------------------------------------
# Storage service: config
# ---------------------------------------------------------------------------


def test_storage_enabled_false_without_creds(monkeypatch):
    monkeypatch.setattr(storage, "B2_KEY_ID", "")
    monkeypatch.setattr(storage, "B2_APP_KEY", "")
    assert storage.storage_enabled() is False


def test_storage_enabled_true_with_creds(monkeypatch):
    monkeypatch.setattr(storage, "B2_KEY_ID", "K123")
    monkeypatch.setattr(storage, "B2_APP_KEY", "secret")
    monkeypatch.setattr(storage, "B2_BUCKET", "b")
    monkeypatch.setattr(storage, "B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com")
    assert storage.storage_enabled() is True


def test_storage_unavailable_raised_when_not_configured(monkeypatch):
    monkeypatch.setattr(storage, "B2_KEY_ID", "")
    with pytest.raises(StorageUnavailableError):
        storage._get_client()


@pytest.mark.parametrize(
    "endpoint,expected",
    [
        # Backblaze S3-compatible endpoint. The leading 's' of 's3' must be kept.
        ("https://s3.eu-central-003.backblazeb2.com", "s3.eu-central-003.backblazeb2.com"),
        ("https://s3.eu-central-003.backblazeb2.com/", "s3.eu-central-003.backblazeb2.com"),
        ("https://s3.us-west-000.backblazeb2.com", "s3.us-west-000.backblazeb2.com"),
        # Local / non-B2 endpoints must not be mangled either.
        ("http://localhost:9000", "localhost:9000"),
        ("https://", ""),
    ],
)
def test_b2_endpoint_host_strips_only_the_scheme(endpoint, expected, monkeypatch):
    """Presigned-URL host comes from the client endpoint; stripping the scheme
    via removeprefix must NOT consume characters from the hostname itself."""
    monkeypatch.setattr(storage, "B2_ENDPOINT", endpoint)
    assert storage._b2_endpoint_host() == expected


def test_b2_endpoint_host_regression_keeps_s3_prefix(monkeypatch):
    """Guard against the str.lstrip character-set bug that turned
    's3.eu-central-003...' into '3.eu-central-003...' (DNS failure)."""
    monkeypatch.setattr(storage, "B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com")
    host = storage._b2_endpoint_host()
    assert host.startswith("s3.")
    assert not host.startswith("3.")


def test_get_client_passes_correct_s3_endpoint_host(monkeypatch):
    """Assert the *client* is actually constructed with the correct S3 host.

    Presigned-URL hostnames come from the endpoint passed to Minio; this pins
    the constructed endpoint to 's3.eu-central-003...' (never '3.eu-central-003'),
    which is the host whose DNS failure was observed in the browser.
    """
    import sys
    from types import ModuleType

    captured = {}

    fake_minio_cls = type("Minio", (), {})
    fake_minio_cls.__init__ = lambda self, endpoint, **kwargs: captured.update(
        endpoint=endpoint, kwargs=kwargs
    )

    fake_minio = ModuleType("minio")
    fake_minio.Minio = fake_minio_cls
    monkeypatch.setitem(sys.modules, "minio", fake_minio)

    monkeypatch.setattr(storage, "B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com")
    monkeypatch.setattr(storage, "B2_KEY_ID", "K123")
    monkeypatch.setattr(storage, "B2_APP_KEY", "secret")
    monkeypatch.setattr(storage, "B2_BUCKET", "strumm-media-prod")
    monkeypatch.setattr(storage, "B2_REGION", "eu-central-003")

    storage._get_client()

    assert captured["endpoint"] == "s3.eu-central-003.backblazeb2.com"
    assert not captured["endpoint"].startswith("3.")
    # Region/signing config must be preserved.
    assert captured["kwargs"]["region"] == "eu-central-003"
    assert captured["kwargs"]["secure"] is True


def test_presigned_url_uses_correct_endpoint_host(monkeypatch):
    """Upload + download presigned URLs must use the configured S3 host.

    MinIO derives each presigned URL's host from the endpoint the client was
    constructed with. This test drives the real _get_client() path with a fake
    MinIO that builds its URL from that very endpoint, so both generated URLs
    must reference 's3.eu-central-003.backblazeb2.com' (never '3.eu-central-003').
    """
    import sys
    from types import ModuleType

    class FakeMinio:
        def __init__(self, endpoint, access_key, secret_key, region, secure):
            self.endpoint = endpoint
            self._secure = secure

        def get_presigned_url(self, method, bucket_name, object_name, expires, **kwargs):
            scheme = "https" if self._secure else "http"
            return f"{scheme}://{self.endpoint}/{bucket_name}/{object_name}?X-Amz-Signature=abc&method={method.lower()}"

    fake_minio = ModuleType("minio")
    fake_minio.Minio = FakeMinio
    monkeypatch.setitem(sys.modules, "minio", fake_minio)

    monkeypatch.setattr(storage, "B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com")
    monkeypatch.setattr(storage, "B2_KEY_ID", "K123")
    monkeypatch.setattr(storage, "B2_APP_KEY", "secret")
    monkeypatch.setattr(storage, "B2_BUCKET", "strumm-media-prod")
    monkeypatch.setattr(storage, "B2_REGION", "eu-central-003")

    upload = create_upload_url(
        "avatar", "507f1f77bcf86cd799439011", "me.png",
        content_type="image/png", size=1000,
    )
    download = create_download_url("users/507f1f77bcf86cd799439011/avatar/abc-me.png")

    expected_host = "s3.eu-central-003.backblazeb2.com"
    assert upload["uploadUrl"].startswith(f"https://{expected_host}/strumm-media-prod/")
    assert download["downloadUrl"].startswith(f"https://{expected_host}/strumm-media-prod/")
    # The host must be 's3.eu-central-003...' — never the mangled '3.eu-central-003...'.
    assert not upload["uploadUrl"].startswith("https://3.eu-central-003.backblazeb2.com/")
    assert not download["downloadUrl"].startswith("https://3.eu-central-003.backblazeb2.com/")


# ---------------------------------------------------------------------------
# Storage service: object keys & sanitization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("category", CATEGORIES)
def test_build_object_key_namespaced(category):
    key = build_object_key(category, "507f1f77bcf86cd799439011", "my photo.png", media_id="abc123")
    owner = "507f1f77bcf86cd799439011"
    assert owner in key
    # collision-resistant unique segment (hex)
    assert "__" not in key
    if category == "avatar":
        assert key.startswith(f"users/{owner}/avatar/")
    elif category == "audio":
        assert key.startswith(f"audio/{owner}/abc123/")
    else:
        assert key.startswith(f"media/{owner}/abc123/")
    assert key.endswith(".png")


def test_build_object_key_sanitizes_filename():
    key = build_object_key("avatar", "user1", "../../../etc/passwd")
    assert ".." not in key
    assert "etc" not in key


def test_build_object_key_unknown_category_rejected():
    with pytest.raises(StorageValidationError):
        build_object_key("bogus", "user1", "f.png")


def test_sanitize_filename_strips_paths_and_dangerous_chars():
    assert "/" not in sanitize_filename("a/b\\c:d?e*")
    assert "../" not in sanitize_filename("../secret.txt")
    assert sanitize_filename("") == "file"
    assert sanitize_filename("../") == "file"


def test_object_key_matches_expected_pattern():
    key = build_object_key("avatar", "507f1f77bcf86cd799439011", "avatar.jpg")
    assert re.fullmatch(r"users/507f1f77bcf86cd799439011/avatar/[0-9a-f]{32}-avatar\.jpg", key)


# ---------------------------------------------------------------------------
# Storage service: validation
# ---------------------------------------------------------------------------


def test_validate_category_rejects_unknown():
    with pytest.raises(StorageValidationError):
        validate_category("nope")


@pytest.mark.parametrize(
    "category,ct,ok",
    [
        ("avatar", "image/png", True),
        ("avatar", "image/jpeg", True),
        ("avatar", "text/html", False),
        ("avatar", "", False),
        ("image", "image/webp", True),
        ("audio", "audio/mpeg", True),
        ("audio", "video/mp4", True),
        ("audio", "application/pdf", False),
    ],
)
def test_validate_mime(category, ct, ok):
    if ok:
        assert validate_mime(category, ct)
    else:
        with pytest.raises(StorageValidationError):
            validate_mime(category, ct)


@pytest.mark.parametrize(
    "category,size,ok",
    [
        ("avatar", 500, True),
        ("avatar", 2_000_000, True),
        ("avatar", 2_000_001, False),   # over avatar 2MB limit
        ("avatar", 0, False),
        ("avatar", -1, False),
        ("image", 4_000_000, True),
        ("image", 5_000_001, False),
        ("audio", 200_000_000, True),
        ("audio", 200_000_001, False),
    ],
)
def test_validate_size(category, size, ok):
    if ok:
        assert validate_size(category, size) == size
    else:
        with pytest.raises(StorageValidationError):
            validate_size(category, size)


# ---------------------------------------------------------------------------
# Storage service: presigned URL generation (mocked client)
# ---------------------------------------------------------------------------


def test_create_upload_url_returns_signed_url_no_secret(monkeypatch):
    fake = MagicMock()

    def fake_presigned(method, bucket_name, object_name, expires, **kwargs):
        return f"https://s3.example/{object_name}?X-Amz-Signature=abcdef"

    fake.get_presigned_url.side_effect = fake_presigned
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    # Simulate a configured application key so the no-leak assertion is real.
    monkeypatch.setattr(storage, "B2_APP_KEY", "Ksecretvalue123")

    result = create_upload_url(
        "avatar", "507f1f77bcf86cd799439011", "me.png",
        content_type="image/png", size=1000,
    )
    assert result["objectKey"].startswith("users/")
    assert "uploadUrl" in result
    assert "X-Amz-Signature=abcdef" in result["uploadUrl"]
    # The presigned URL must never contain the application key.
    assert storage.B2_APP_KEY not in result["uploadUrl"]
    assert result["category"] == "avatar"
    assert result["contentType"] == "image/png"


def test_create_upload_url_validates_inputs(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    # invalid mime -> rejected before any client interaction
    with pytest.raises(StorageValidationError):
        create_upload_url("avatar", "u1", "x.html", content_type="text/html", size=1000)
    # invalid size -> rejected
    with pytest.raises(StorageValidationError):
        create_upload_url("avatar", "u1", "x.png", content_type="image/png", size=99_000_000)
    assert fake.get_presigned_url.call_count == 0


def test_create_upload_url_propagates_client_failure(monkeypatch):
    fake = MagicMock()
    fake.get_presigned_url.side_effect = RuntimeError("connect failed")
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    with pytest.raises(StorageError):
        create_upload_url("image", "u1", "x.png", content_type="image/png", size=1000)


def test_create_download_url_returns_signed_url_no_secret(monkeypatch):
    fake = MagicMock()
    fake.get_presigned_url.return_value = "https://s3.example/key?X-Amz-Signature=zzz"
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    monkeypatch.setattr(storage, "B2_APP_KEY", "Ksecretvalue123")
    result = create_download_url("media/u1/abc/1.png")
    assert storage.B2_APP_KEY not in result["downloadUrl"]
    assert result["expiresIn"] == int(storage.DOWNLOAD_URL_EXPIRES.total_seconds())


def test_delete_object_calls_remove(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    delete_object("media/u1/abc/1.png")
    fake.remove_object.assert_called_once_with(storage.B2_BUCKET, "media/u1/abc/1.png")


def test_object_exists_stats(monkeypatch):
    fake = MagicMock()
    monkeypatch.setattr(storage, "_get_client", lambda: fake)
    assert object_exists("k") is True
    fake.stat_object.side_effect = RuntimeError("not found")
    assert object_exists("k") is False


# ---------------------------------------------------------------------------
# /media endpoints: end-to-end via AsyncClient
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_url_requires_auth():
    """Without a valid user, /media/upload-url must reject (401)."""
    from app.main import app as _app
    from app.routes.dependencies import get_current_user
    _app.dependency_overrides.pop(get_current_user, None)  # real auth -> no token

    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=_app), base_url="http://test") as c:
        resp = await c.post("/media/upload-url", json={
            "category": "avatar", "filename": "me.png",
            "contentType": "image/png", "size": 1000,
        })
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_upload_url_returns_signed_url_and_persists(client, monkeypatch):
    from app.main import app as _app
    from app.routes.dependencies import get_current_user
    async def mock_user():
        return {"id": "507f1f77bcf86cd799439011", "username": "testuser"}
    _app.dependency_overrides[get_current_user] = mock_user

    fake = MagicMock()
    fake.get_presigned_url.return_value = "https://s3.example/key?X-Amz-Signature=zzz"
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.post("/media/upload-url", json={
        "category": "avatar", "filename": "me.png",
        "contentType": "image/png", "size": 1000,
    })
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["objectKey"].startswith("users/507f1f77bcf86cd799439011/avatar/")
    assert body["uploadUrl"].startswith("https://s3.example/")
    assert "mediaId" in body
    # ensure the app key is never in the response
    assert "secret" not in resp.text


@pytest.mark.asyncio
async def test_upload_url_rejects_invalid_mime(client, monkeypatch):
    from app.main import app as _app
    from app.routes.dependencies import get_current_user
    async def mock_user():
        return {"id": "507f1f77bcf86cd799439011", "username": "testuser"}
    _app.dependency_overrides[get_current_user] = mock_user
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.post("/media/upload-url", json={
        "category": "avatar", "filename": "evil.html",
        "contentType": "text/html", "size": 1000,
    })
    assert resp.status_code == 400
    assert fake.get_presigned_url.call_count == 0


@pytest.mark.asyncio
async def test_upload_url_rejects_oversized(client, monkeypatch):
    from app.main import app as _app
    from app.routes.dependencies import get_current_user
    async def mock_user():
        return {"id": "507f1f77bcf86cd799439011", "username": "testuser"}
    _app.dependency_overrides[get_current_user] = mock_user
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.post("/media/upload-url", json={
        "category": "avatar", "filename": "me.png",
        "contentType": "image/png", "size": 50_000_000,
    })
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_download_url_authorizes_owner(monkeypatch):
    client = make_client([{
        "_id": "507f1f77bcf86cd799439013",
        "ownerId": "507f1f77bcf86cd799439011",
        "category": "avatar",
        "objectKey": "users/507f1f77bcf86cd799439011/avatar/abc-me.png",
        "mime": "image/png",
        "status": "ready",
        "deletedAt": None,
    }])
    fake = MagicMock()
    fake.get_presigned_url.return_value = "https://s3.example/key?X-Amz-Signature=zzz"
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    deep_key = "users/507f1f77bcf86cd799439011/avatar/abc-me.png"
    resp = await client.get("/media/download-url", params={"key": deep_key})
    assert resp.status_code == 200
    assert "url" in resp.json()["data"]


@pytest.mark.asyncio
async def test_download_url_rejects_foreign_owner(monkeypatch):
    # object owned by a DIFFERENT owner than the authenticated user
    client = make_client([{
        "_id": "507f1f77bcf86cd799439014",
        "ownerId": "000000000000000000000000",  # not the authed user
        "category": "avatar",
        "objectKey": "users/000000000000000000000000/avatar/secret.png",
        "mime": "image/png",
        "status": "ready",
        "deletedAt": None,
    }])
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.get(
        "/media/download-url",
        params={"key": "users/000000000000000000000000/avatar/secret.png"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_download_url_unknown_object(monkeypatch):
    client = make_client([])
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)
    resp = await client.get("/media/download-url", params={"key": "does/not/exist.png"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_authorizes_owner(monkeypatch):
    client = make_client([{
        "_id": "507f1f77bcf86cd799439013",
        "ownerId": "507f1f77bcf86cd799439011",
        "category": "image",
        "objectKey": "media/507f1f77bcf86cd799439011/abc/img.png",
        "mime": "image/png",
        "status": "ready",
        "deletedAt": None,
    }])
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.request(
        "DELETE", "/media/", json={"key": "media/507f1f77bcf86cd799439011/abc/img.png"}
    )
    assert resp.status_code == 200
    fake.remove_object.assert_called_once()
    # record soft-deleted
    assert resp.json()["data"]["status"] == "deleted"


@pytest.mark.asyncio
async def test_delete_rejects_foreign_owner(monkeypatch):
    client = make_client([{
        "_id": "507f1f77bcf86cd799439014",
        "ownerId": "000000000000000000000000",  # not the authed user
        "category": "image",
        "objectKey": "media/000000000000000000000000/abc/img.png",
        "mime": "image/png",
        "status": "ready",
        "deletedAt": None,
    }])
    fake = MagicMock()
    monkeypatch.setattr("app.services.storage._get_client", lambda: fake)

    resp = await client.request(
        "DELETE", "/media/", json={"key": "media/000000000000000000000000/abc/img.png"}
    )
    assert resp.status_code == 403
    fake.remove_object.assert_not_called()


@pytest.mark.asyncio
async def test_confirm_marks_ready():
    client = make_client([{
        "_id": "507f1f77bcf86cd799439013",
        "ownerId": "507f1f77bcf86cd799439011",
        "category": "avatar",
        "objectKey": "users/507f1f77bcf86cd799439011/avatar/abc.png",
        "mime": "image/png",
        "status": "pending",
        "deletedAt": None,
    }])
    resp = await client.post("/media/confirm", json={"mediaId": "507f1f77bcf86cd799439013"})
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "ready"