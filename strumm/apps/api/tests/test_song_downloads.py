import pytest
import httpx

from app.main import app
from app.routes import song_downloads
from app.routes.dependencies import get_current_user


TEST_USER = {
    "id": "64a1b2c3d4e5f67890123456",
    "username": "testuser",
    "email": "test@example.com",
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


def openverse_item(**overrides):
    item = {
        "id": "openverse-1",
        "title": "Test Song",
        "creator": "Test Artist",
        "url": "https://media.example/test-song.mp3",
        "foreign_landing_url": "https://source.example/test-song",
        "license": "cc0",
        "license_version": "1.0",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Test Song by Test Artist is CC0.",
        "filetype": "mp3",
        "duration": 172000,
    }
    item.update(overrides)
    return item


def ccmixter_item(**overrides):
    item = {
        "upload_id": 123,
        "upload_name": "Test Song",
        "user_name": "Test Artist",
        "file_page_url": "https://ccmixter.org/files/test-artist/123",
        "license_name": "Attribution",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "files": [
            {
                "file_name": "test-song.mp3",
                "download_url": "https://ccmixter.org/content/TestArtist/test-song.mp3",
                "file_format_info": {"mime_type": "audio/mpeg", "ps": "2:52"},
            }
        ],
    }
    item.update(overrides)
    return item


@pytest.mark.asyncio
async def test_openverse_finds_commercially_usable_exact_mp3(monkeypatch):
    calls = []

    async def provider_json(url, params=None, headers=None):
        calls.append((url, params))
        return {"results": [openverse_item()]}

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_openverse("Test Song", "Test Artist", 172)

    assert result is not None
    assert result.provider == "openverse"
    assert result.audio_url == "https://media.example/test-song.mp3"
    assert result.license == "CC0 1.0"
    assert calls[0][1]["license_type"] == "commercial"
    assert calls[0][1]["extension"] == "mp3"
    assert "category" not in calls[0][1]
    assert "length" not in calls[0][1]


@pytest.mark.asyncio
async def test_openverse_rejects_noncommercial_and_duration_mismatch(monkeypatch):
    async def provider_json(url, params=None, headers=None):
        return {
            "results": [
                openverse_item(license="by-nc"),
                openverse_item(id="wrong-duration", duration=250000),
            ]
        }

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_openverse("Test Song", "Test Artist", 172)

    assert result is None


@pytest.mark.asyncio
async def test_openverse_requires_song_length_when_duration_is_missing(monkeypatch):
    async def provider_json(url, params=None, headers=None):
        return {"results": [openverse_item(duration=12000)]}

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_openverse("Test Song", "Test Artist", 0)

    assert result is None


@pytest.mark.asyncio
async def test_openverse_accepts_uncategorized_result_when_duration_matches(monkeypatch):
    async def provider_json(url, params=None, headers=None):
        return {"results": [openverse_item(category=None, duration=172000)]}

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_openverse("Test Song", "Test Artist", 172)

    assert result is not None
    assert result.provider == "openverse"


@pytest.mark.asyncio
async def test_ccmixter_finds_attribution_licensed_mp3(monkeypatch):
    calls = []

    async def provider_json(url, params=None, headers=None):
        calls.append((url, params))
        return [ccmixter_item()]

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_ccmixter("Test Song", "Test Artist", 172)

    assert result is not None
    assert result.provider == "ccmixter"
    assert result.audio_url.endswith("test-song.mp3")
    assert result.license_url.startswith("https://creativecommons.org/licenses/by/")
    assert calls[0][1]["f"] == "js"
    assert calls[0][1]["lic"] == "by"


@pytest.mark.asyncio
async def test_ccmixter_skips_sample_file_and_uses_full_track(monkeypatch):
    item = ccmixter_item()
    item["files"] = [
        {
            "file_name": "test-sample.mp3",
            "download_url": "https://ccmixter.org/content/TestArtist/test-sample.mp3",
            "file_format_info": {"mime_type": "audio/mpeg", "ps": "2:52"},
            "file_extra": {"type": "samples", "ccud": "sample,media"},
        },
        {
            "file_name": "test-song.mp3",
            "download_url": "https://ccmixter.org/content/TestArtist/test-song.mp3",
            "file_format_info": {"mime_type": "audio/mpeg", "ps": "2:52"},
            "file_extra": {"sha1": "example"},
        },
    ]

    async def provider_json(url, params=None, headers=None):
        return [item]

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_ccmixter("Test Song", "Test Artist", 172)

    assert result is not None
    assert result.audio_url.endswith("test-song.mp3")


@pytest.mark.asyncio
async def test_ccmixter_rejects_noncommercial_license(monkeypatch):
    async def provider_json(url, params=None, headers=None):
        return [ccmixter_item(license_url="https://creativecommons.org/licenses/by-nc/4.0/")]

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_ccmixter("Test Song", "Test Artist", 172)

    assert result is None


@pytest.mark.asyncio
async def test_epidemic_download_resolves_full_track_after_metadata_match(monkeypatch):
    monkeypatch.setenv("EPIDEMIC_SOUND_API_KEY", "test-api-key")
    monkeypatch.setenv("EPIDEMIC_SOUND_PRODUCTION_LICENSE_CONFIRMED", "true")
    calls = []

    async def provider_json(url, params=None, headers=None):
        calls.append((url, params, headers))
        if url.endswith("/tracks/search"):
            return {
                "tracks": [
                    {
                        "id": "6rUPerw2po",
                        "title": "Test Song",
                        "mainArtists": ["Test Artist"],
                        "featuredArtists": [],
                        "length": 172,
                        "isPreviewOnly": True,
                    }
                ]
            }
        if url.endswith("/tracks/6rUPerw2po/download"):
            return {"url": "https://cdn.example/test-song.mp3", "expires": "2030-01-01T00:00:00Z"}
        return None

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_epidemic("Test Song", "Test Artist", 172, TEST_USER["id"])

    assert result is not None
    assert result.provider == "epidemic-sound"
    assert result.audio_url == "https://cdn.example/test-song.mp3"
    assert calls[0][1]["term"] == "Test Song Test Artist"
    assert calls[0][2]["Authorization"] == "Bearer test-api-key"
    assert calls[1][1] == {"format": "mp3", "quality": "normal"}


@pytest.mark.asyncio
async def test_epidemic_skips_duration_mismatch(monkeypatch):
    monkeypatch.setenv("EPIDEMIC_SOUND_API_KEY", "test-api-key")
    monkeypatch.setenv("EPIDEMIC_SOUND_PRODUCTION_LICENSE_CONFIRMED", "true")
    calls = []

    async def provider_json(url, params=None, headers=None):
        calls.append(url)
        return {
            "tracks": [
                {
                    "id": "6rUPerw2po",
                    "title": "Test Song",
                    "mainArtists": ["Test Artist"],
                    "featuredArtists": [],
                    "length": 240,
                }
            ]
        }

    monkeypatch.setattr(song_downloads, "_provider_json", provider_json)

    result = await song_downloads._find_epidemic("Test Song", "Test Artist", 172, TEST_USER["id"])

    assert result is None
    assert all(not url.endswith("/download") for url in calls)


def test_epidemic_sound_requires_production_license_gate(monkeypatch):
    monkeypatch.setenv("EPIDEMIC_SOUND_API_KEY", "test-api-key")
    monkeypatch.delenv("EPIDEMIC_SOUND_PRODUCTION_LICENSE_CONFIRMED", raising=False)

    assert song_downloads._epidemic_enabled() is False

    monkeypatch.setenv("EPIDEMIC_SOUND_PRODUCTION_LICENSE_CONFIRMED", "true")

    assert song_downloads._epidemic_enabled() is True


@pytest.mark.asyncio
async def test_download_route_streams_provider_mp3_and_attribution(client, monkeypatch):
    source = song_downloads.DownloadSource(
        provider="openverse",
        audio_url="https://media.example/test-song.mp3",
        title="Test Song",
        artist="Test Artist",
        source_url="https://source.example/test-song",
        license="CC0 1.0",
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution="Test Song by Test Artist is CC0.",
        track_id="openverse-1",
    )
    upstream = httpx.Response(
        200,
        headers={"content-type": "audio/mpeg", "content-length": "11"},
        content=b"ID3-audio-bytes",
    )
    opened = song_downloads.OpenedMedia(response=upstream, clients=[])
    quota_calls = []

    async def find_openverse(*args):
        return source

    async def find_ccmixter(*args):
        raise AssertionError("ccMixter should not run after an Openverse match")

    async def find_epidemic(*args):
        raise AssertionError("Epidemic Sound should not run after an Openverse match")

    async def open_external(url, range_header=None, referer=None):
        assert url == source.audio_url
        assert referer == source.source_url
        return opened

    async def consume(user_id):
        quota_calls.append(user_id)
        return True

    monkeypatch.setattr(song_downloads, "_find_openverse", find_openverse)
    monkeypatch.setattr(song_downloads, "_find_ccmixter", find_ccmixter)
    monkeypatch.setattr(song_downloads, "_find_epidemic", find_epidemic)
    monkeypatch.setattr(song_downloads, "_open_external_audio", open_external)
    monkeypatch.setattr(song_downloads, "try_consume_song_download", consume)

    async with client:
        response = await client.post(
            "/downloads/song",
            json={"title": "Test Song", "artist": "Test Artist", "duration": 172},
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["x-download-provider"] == "openverse"
    assert response.headers["x-download-source-url"] == source.source_url
    assert response.headers["x-download-license"] == "CC0%201.0"
    assert response.headers["x-download-license-url"] == source.license_url
    assert response.headers["x-download-attribution"] == "Test%20Song%20by%20Test%20Artist%20is%20CC0."
    assert response.content == b"ID3-audio-bytes"
    assert quota_calls == [TEST_USER["id"]]


@pytest.mark.asyncio
async def test_download_route_falls_through_when_first_provider_media_is_broken(client, monkeypatch):
    openverse_source = song_downloads.DownloadSource(
        provider="openverse",
        audio_url="https://media.example/broken.mp3",
        title="Test Song",
        artist="Test Artist",
    )
    ccmixter_source = song_downloads.DownloadSource(
        provider="ccmixter",
        audio_url="https://ccmixter.org/content/TestArtist/test-song.mp3",
        title="Test Song",
        artist="Test Artist",
        license="Attribution",
    )
    upstream = httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"ID3")
    opened = song_downloads.OpenedMedia(response=upstream, clients=[])
    attempted = []

    async def find_openverse(*args):
        return openverse_source

    async def find_ccmixter(*args):
        return ccmixter_source

    async def find_epidemic(*args):
        raise AssertionError("Epidemic should not run after a successful ccMixter match")

    async def open_external(url, range_header=None, referer=None):
        attempted.append(url)
        if url == openverse_source.audio_url:
            raise song_downloads.HTTPException(status_code=502, detail="Invalid preview file")
        return opened

    async def consume(user_id):
        return True

    monkeypatch.setattr(song_downloads, "_find_openverse", find_openverse)
    monkeypatch.setattr(song_downloads, "_find_ccmixter", find_ccmixter)
    monkeypatch.setattr(song_downloads, "_find_epidemic", find_epidemic)
    monkeypatch.setattr(song_downloads, "_open_external_audio", open_external)
    monkeypatch.setattr(song_downloads, "try_consume_song_download", consume)

    async with client:
        response = await client.post(
            "/downloads/song",
            json={"title": "Test Song", "artist": "Test Artist", "duration": 172},
        )

    assert response.status_code == 200
    assert response.headers["x-download-provider"] == "ccmixter"
    assert attempted == [openverse_source.audio_url, ccmixter_source.audio_url]
    assert response.content == b"ID3"
