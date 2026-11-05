import asyncio

import httpx
import pytest

from app.main import app
from app.routes import audius
from app.models.schemas import SongSchema


@pytest.fixture
def client():
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def track(**overrides):
    value = {
        "id": "KlK59",
        "title": "Wobblebug - INVADE",
        "user": {"name": "Sweeppah", "handle": "sweeppah"},
        "duration": 172,
        "is_downloadable": False,
        "is_streamable": True,
        "is_stream_gated": False,
        "stream_conditions": None,
        "license": "All rights reserved",
        "permalink": "/sweeppah/wobblebug-invade",
        "artwork": {"_480x480": "https://creatornode.audius.co/artwork.jpg"},
    }
    value.update(overrides)
    return value


@pytest.mark.asyncio
async def test_search_returns_only_publicly_streamable_tracks(client, monkeypatch):
    async def search(path, params=None):
        assert path == "/tracks/search"
        return [
            track(),
            track(id="gated", is_stream_gated=True, stream_conditions={"follow_user_id": 123}),
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
    song = payload["data"][0]
    assert song["videoId"] == "audius-KlK59"
    assert song["artist"] == "Sweeppah"
    assert song["metadata"]["provider"] == "audius"
    assert song["metadata"]["audiusTrackId"] == "KlK59"
    assert song["metadata"]["audioUrl"] == "/audius/tracks/KlK59/stream"
    assert song["metadata"]["streamable"] is True
    assert song["metadata"]["audiusPermalink"] == "https://audius.co/sweeppah/wobblebug-invade"


@pytest.mark.asyncio
async def test_search_paginates_past_non_streamable_results(client, monkeypatch):
    requested_offsets = []

    async def search(path, params=None):
        requested_offsets.append(params["offset"])
        if params["offset"] == 0:
            return [track(is_streamable=False), track(id="unlisted", is_unlisted=True)]
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
async def test_audius_download_routes_are_removed(client):
    async with client:
        direct = await client.get("/audius/tracks/KlK59/download")
        matched = await client.post("/audius/download", json={"title": "Track", "artist": "Artist"})

    assert direct.status_code == 404
    assert matched.status_code == 404


@pytest.mark.asyncio
async def test_stream_rejects_non_streamable_track(client, monkeypatch):
    async def get_track(track_id):
        return track(is_streamable=False)

    monkeypatch.setattr(audius, "_get_track", get_track)

    async with client:
        response = await client.get("/audius/tracks/KlK59/stream")

    assert response.status_code == 403


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


def test_audio_redirect_allowlist_rejects_untrusted_hosts():
    assert audius._allowed_audio_url("https://audius-content-8.figment.io/tracks/file")
    assert audius._allowed_audio_url("https://creatornode.audius.co/tracks/file")
    assert audius._allowed_audio_url("https://validator.example.r2.cloudflarestorage.com/tracks/file")
    assert not audius._allowed_audio_url("http://audius.co/tracks/file")
    assert not audius._allowed_audio_url("https://audius.co:8443/tracks/file")
    assert not audius._allowed_audio_url("https://audius.co:invalid/tracks/file")
    assert not audius._allowed_audio_url("https://evil.example/tracks/file")
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
async def test_stream_rejects_unsupported_upstream_redirect(monkeypatch):
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
        await audius._open_audius_media("/tracks/KlK59/stream")
    assert getattr(exc.value, "status_code", None) == 502


@pytest.mark.asyncio
async def test_stream_retries_through_discovery_after_temporary_node_failure(monkeypatch):
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
        "/tracks/KlK59/stream",
        {"app_name": "strumm"},
        "bytes=0-3",
    )

    assert response.status_code == 206
    assert requested_urls[0] == requested_urls[2] == "https://api.audius.co/v1/tracks/KlK59/stream"
    assert requested_urls[1] == "https://cn1.mainnet.audiusindex.org/tracks/audio"
    assert requested_urls[3] == "https://cn2.mainnet.audiusindex.org/tracks/audio"
    await response.aclose()


@pytest.mark.asyncio
async def test_audius_json_retries_transient_timeout(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200
        is_success = True

        def json(self):
            return {"data": [{"id": "KlK59"}]}

    class FakeClient:
        async def get(self, *args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) == 1:
                raise httpx.ReadTimeout("temporary Audius timeout")
            return FakeResponse()

    monkeypatch.setattr(audius, "get_http_client", lambda: FakeClient())

    async def no_sleep(_):
        return None

    monkeypatch.setattr(audius.asyncio, "sleep", no_sleep)
    result = await audius._audius_json("/tracks/search", {"query": "Wobblebug"})

    assert result == [{"id": "KlK59"}]
    assert len(calls) == 2
