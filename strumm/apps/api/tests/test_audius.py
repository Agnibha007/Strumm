import pytest
import httpx

from app.main import app
from app.routes import audius
from app.models.schemas import SongSchema
from app.routes.dependencies import get_current_user


TEST_USER = {
    "id": "64a1b2c3d4e5f67890123456",
    "username": "testuser",
    "email": "test@example.com",
    "createdAt": "2025-01-01T00:00:00",
}


@pytest.fixture
def client(monkeypatch):
    previous = app.dependency_overrides.get(get_current_user)

    async def override_current_user():
        return TEST_USER

    app.dependency_overrides[get_current_user] = override_current_user
    from httpx import ASGITransport, AsyncClient

    test_client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    yield test_client
    if previous is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = previous


def track(**overrides):
    value = {
        "id": "KlK59",
        "title": "Wobblebug - INVADE",
        "user": {"name": "Sweeppah", "handle": "sweeppah"},
        "duration": 172,
        "is_downloadable": True,
        "is_download_gated": False,
        "download_conditions": None,
        "is_streamable": True,
        "is_stream_gated": False,
        "stream_conditions": None,
        "license": "All rights reserved",
        "permalink": "/sweeppah/wobblebug-invade",
        "orig_filename": "Wobblebug - INVADE.mp3",
        "artwork": {"_480x480": "https://creatornode.audius.co/artwork.jpg"},
    }
    value.update(overrides)
    return value


@pytest.mark.asyncio
async def test_search_returns_only_publicly_downloadable_and_streamable_tracks(client, monkeypatch):
    async def search(path, params=None):
        assert path == "/tracks/search"
        assert params["only_downloadable"] == "true"
        return [
            track(),
            track(id="gated", is_download_gated=True, download_conditions={"follow_user_id": 123}),
            track(id="not-downloadable", is_downloadable=False),
            track(id="not-streamable", is_streamable=False),
            track(id="unavailable", is_available=False),
            track(id="deleted", is_delete=True),
            track(id="unlisted", is_unlisted=True),
        ]

    monkeypatch.setattr(audius, "_audius_json", search)

    async with client:
        response = await client.get("/audius/tracks/search?q=lofi")

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert len(payload["data"]) == 1
    song = payload["data"][0]
    assert song["videoId"] == "audius-KlK59"
    assert song["artist"] == "Sweeppah"
    assert song["metadata"]["provider"] == "audius"
    assert song["metadata"]["audiusTrackId"] == "KlK59"
    assert song["metadata"]["audioUrl"] == "/audius/tracks/KlK59/stream"
    assert song["metadata"]["downloadable"] is True
    assert song["metadata"]["audiusPermalink"] == "https://audius.co/sweeppah/wobblebug-invade"


@pytest.mark.asyncio
async def test_search_paginates_past_non_downloadable_results(client, monkeypatch):
    requested_offsets = []

    async def search(path, params=None):
        requested_offsets.append(params["offset"])
        if params["offset"] == 0:
            return [track(is_downloadable=False), track(id="unlisted", is_unlisted=True)]
        if params["offset"] == 100:
            return [track(id="public-two")]
        return []

    monkeypatch.setattr(audius, "_audius_json", search)

    async with client:
        response = await client.get("/audius/tracks/search?q=lofi&limit=24")

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert [song["metadata"]["audiusTrackId"] for song in payload["data"]] == ["public-two"]
    assert set(requested_offsets) == {0, 100, 200, 300}


@pytest.mark.asyncio
async def test_search_rejects_blank_query(client):
    async with client:
        response = await client.get("/audius/tracks/search?q=%20%20")

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_download_rejects_invalid_track_id(client):
    async with client:
        response = await client.get("/audius/tracks/not-valid!/download")

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_download_rejects_track_without_public_download_permission(client, monkeypatch):
    async def get_track(track_id):
        return track(is_downloadable=False)

    quota_calls = []
    async def consume(user_id):
        quota_calls.append(user_id)
        return True

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download")

    assert response.status_code == 403
    assert quota_calls == []


@pytest.mark.asyncio
async def test_download_rejects_follow_gated_track(client, monkeypatch):
    async def get_track(track_id):
        return track(is_download_gated=True, download_conditions={"follow_user_id": 123})

    monkeypatch.setattr(audius, "_get_track", get_track)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_download_streams_real_mp3_response_and_consumes_quota(client, monkeypatch):
    async def get_track(track_id):
        return track()

    opened = []
    async def open_media(path, params=None, range_header=None):
        opened.append((path, params, range_header))
        return httpx.Response(
            200,
            headers={
                "content-type": "audio/mpeg",
                "content-length": "11",
            },
            content=b"ID3-audio-bytes",
        )

    quota_calls = []
    async def consume(user_id):
        quota_calls.append(user_id)
        return True

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert "attachment" in response.headers["content-disposition"]
    assert "Wobblebug%20-%20INVADE.mp3" in response.headers["content-disposition"]
    assert response.content == b"ID3-audio-bytes"
    assert opened == [("/tracks/KlK59/download", {"app_name": "strumm", "original": "false"}, None)]
    assert quota_calls == [TEST_USER["id"]]


@pytest.mark.asyncio
async def test_download_forwards_range_header_and_preserves_partial_response(client, monkeypatch):
    async def get_track(track_id):
        return track()

    opened = []
    async def open_media(path, params=None, range_header=None):
        opened.append(range_header)
        return httpx.Response(
            206,
            headers={
                "content-type": "audio/mpeg",
                "content-length": "4",
                "content-range": "bytes 0-3/11",
            },
            content=b"ID3!",
        )

    async def consume(user_id):
        return True

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download", headers={"Range": "bytes=0-3"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-3/11"
    assert response.content == b"ID3!"
    assert opened == ["bytes=0-3"]


@pytest.mark.asyncio
async def test_download_enforces_daily_quota_and_closes_upstream(client, monkeypatch):
    async def get_track(track_id):
        return track()

    upstream = httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"ID3")
    async def open_media(path, params=None, range_header=None):
        return upstream

    async def consume(user_id):
        return False

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download")

    assert response.status_code == 429
    assert upstream.is_closed


@pytest.mark.asyncio
async def test_stream_rejects_non_streamable_track(client, monkeypatch):
    async def get_track(track_id):
        return track(is_streamable=False)

    monkeypatch.setattr(audius, "_get_track", get_track)

    async with client:
        response = await client.get("/audius/tracks/KlK59/stream")

    assert response.status_code == 403


def test_audio_redirect_allowlist_rejects_untrusted_hosts():
    assert audius._allowed_audio_url("https://audius-content-8.figment.io/tracks/file")
    assert audius._allowed_audio_url("https://creatornode.audius.co/tracks/file")
    assert not audius._allowed_audio_url("http://audius.co/tracks/file")
    assert not audius._allowed_audio_url("https://audius.co:8443/tracks/file")
    assert not audius._allowed_audio_url("https://audius.co:invalid/tracks/file")
    assert not audius._allowed_audio_url("https://evil.example/tracks/file")
    assert audius._allowed_audio_url("https://validator.example.r2.cloudflarestorage.com/tracks/file")
    assert not audius._allowed_audio_url("https://audius.co.evil.example/tracks/file")
    assert not audius._allowed_audio_url("https://user:pass@audius.co/tracks/file")


def test_song_schema_keeps_audius_ids_out_of_the_normal_song_catalog():
    for video_id in ("audius-KlK59", "soundcloud-123"):
        with pytest.raises(ValueError):
            SongSchema(
                videoId=video_id,
                title="Test Track",
                artist="Test Artist",
                thumbnail="",
                duration=172,
            )


@pytest.mark.asyncio
async def test_stream_forwards_range_header_and_preserves_partial_response(client, monkeypatch):
    async def get_track(track_id):
        return track()

    opened = []
    async def open_media(path, params=None, range_header=None):
        opened.append((path, range_header))
        return httpx.Response(
            206,
            headers={
                "content-type": "audio/mpeg",
                "content-length": "4",
                "content-range": "bytes 0-3/11",
            },
            content=b"ID3!",
        )

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)

    async with client:
        response = await client.get("/audius/tracks/KlK59/stream", headers={"Range": "bytes=0-3"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-3/11"
    assert response.content == b"ID3!"
    assert opened == [("/tracks/KlK59/stream", "bytes=0-3")]


@pytest.mark.asyncio
async def test_download_rejects_unsupported_upstream_redirect(monkeypatch):
    class FakeResponse:
        status_code = 302
        headers = {"location": "https://evil.example/steal"}

        async def aclose(self):
            self.closed = True

    class FakeClient:
        def build_request(self, *args, **kwargs):
            return object()

        async def send(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(audius, "get_http_client", lambda: FakeClient())

    with pytest.raises(Exception) as exc:
        await audius._open_audius_media("/tracks/KlK59/download")
    assert getattr(exc.value, "status_code", None) == 502


@pytest.mark.asyncio
async def test_media_retries_through_discovery_after_temporary_node_failure(monkeypatch):
    responses = [
        httpx.Response(302, headers={"location": "https://cn1.mainnet.audiusindex.org/tracks/audio"}),
        httpx.Response(522),
        httpx.Response(302, headers={"location": "https://cn2.mainnet.audiusindex.org/tracks/audio"}),
        httpx.Response(
            206,
            headers={
                "content-type": "audio/mpeg",
                "content-length": "4",
                "content-range": "bytes 0-3/11",
            },
            content=b"ID3!",
        ),
    ]
    requested_urls = []

    class FakeClient:
        def build_request(self, method, url, **kwargs):
            return httpx.Request(method, url, params=kwargs.get("params"))

        async def send(self, request, **kwargs):
            requested_urls.append(str(request.url).split("?", 1)[0])
            return responses.pop(0)

    monkeypatch.setattr(audius, "get_http_client", lambda: FakeClient())

    response = await audius._open_audius_media(
        "/tracks/KlK59/download",
        {"original": "false"},
        "bytes=0-3",
    )

    assert response.status_code == 206
    assert requested_urls[0] == requested_urls[2] == "https://api.audius.co/v1/tracks/KlK59/download"
    assert requested_urls[1] == "https://cn1.mainnet.audiusindex.org/tracks/audio"
    assert requested_urls[3] == "https://cn2.mainnet.audiusindex.org/tracks/audio"
    await response.aclose()


@pytest.mark.asyncio
async def test_download_closes_upstream_when_quota_service_fails(client, monkeypatch):
    async def get_track(track_id):
        return track()

    upstream = httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"ID3")
    async def open_media(path, params=None, range_header=None):
        return upstream

    async def consume(user_id):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(audius, "_get_track", get_track)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.get("/audius/tracks/KlK59/download")

    assert response.status_code == 503
    assert upstream.is_closed


@pytest.mark.asyncio
async def test_download_match_uses_title_and_artist_and_rejects_weak_matches(monkeypatch):
    requested = []

    async def search(path, params=None):
        requested.append(params)
        return [track()]

    monkeypatch.setattr(audius, "_audius_json", search)

    match = await audius._find_downloadable_match("Wobblebug - INVADE", "Sweeppah")
    no_match = await audius._find_downloadable_match("Completely Different Song", "Different Artist")

    assert match is not None
    assert match["id"] == "KlK59"
    assert no_match is None
    assert requested[0]["query"] == "Wobblebug - INVADE Sweeppah"


@pytest.mark.asyncio
async def test_download_by_song_metadata_returns_audius_audio_and_attribution(client, monkeypatch):
    async def search(path, params=None):
        assert path == "/tracks/search"
        return [track()]

    opened = []
    async def open_media(path, params=None, range_header=None):
        opened.append((path, params, range_header))
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg", "content-length": "11"},
            content=b"ID3-audio-bytes",
        )

    quota_calls = []
    async def consume(user_id):
        quota_calls.append(user_id)
        return True

    monkeypatch.setattr(audius, "_audius_json", search)
    monkeypatch.setattr(audius, "_open_audius_media", open_media)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.post(
            "/audius/download",
            json={"title": "Wobblebug - INVADE", "artist": "Sweeppah"},
        )

    assert response.status_code == 200
    assert response.content == b"ID3-audio-bytes"
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["x-audius-source-url"] == "https://audius.co/sweeppah/wobblebug-invade"
    assert response.headers["x-audius-license"] == "All%20rights%20reserved"
    assert "Wobblebug" in response.headers["content-disposition"]
    assert opened == [("/tracks/KlK59/download", {"original": "false"}, None)]
    assert quota_calls == [TEST_USER["id"]]


@pytest.mark.asyncio
async def test_download_by_song_metadata_rejects_unmatched_song_without_consuming_quota(client, monkeypatch):
    async def search(path, params=None):
        return [track()]

    quota_calls = []
    async def consume(user_id):
        quota_calls.append(user_id)
        return True

    monkeypatch.setattr(audius, "_audius_json", search)
    monkeypatch.setattr(audius, "try_consume_song_download", consume)

    async with client:
        response = await client.post(
            "/audius/download",
            json={"title": "An unrelated song", "artist": "Unknown Artist"},
        )

    assert response.status_code == 404
    assert quota_calls == []
