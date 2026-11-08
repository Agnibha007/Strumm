import asyncio

import pytest

from app.main import app
from app.routes import song_downloads
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


@pytest.mark.asyncio
async def test_download_streams_ytdlp_mp3_directly_to_client(client, monkeypatch):
    started = []

    async def stream_mp3(video_id):
        started.append(video_id)

        async def chunks():
            yield b"ID3"
            yield b"mp3-audio"

        return chunks()

    monkeypatch.setattr(song_downloads, "_start_ytdlp_mp3_stream", stream_mp3)

    async with client:
        response = await client.post(
            "/downloads/song",
            json={
                "videoId": "6rOCiszTz-I",
                "title": "Egiye de",
                "artist": "SVF Music",
                "duration": 260,
                "rightsConfirmed": True,
            },
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["x-download-provider"] == "yt-dlp"
    assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate"
    assert "Egiye-de.mp3" in response.headers["content-disposition"]
    assert response.content == b"ID3mp3-audio"
    assert started == ["6rOCiszTz-I"]


@pytest.mark.asyncio
async def test_download_requires_explicit_rights_confirmation(client, monkeypatch):
    started = []

    async def stream_mp3(video_id):
        started.append(video_id)
        return iter(())

    monkeypatch.setattr(song_downloads, "_start_ytdlp_mp3_stream", stream_mp3)

    async with client:
        response = await client.post(
            "/downloads/song",
            json={"videoId": "6rOCiszTz-I", "title": "Track", "rightsConfirmed": False},
        )

    assert response.status_code == 400
    assert "permission" in response.json()["detail"]
    assert started == []


@pytest.mark.asyncio
async def test_download_rejects_non_youtube_ids(client, monkeypatch):
    started = []

    async def stream_mp3(video_id):
        started.append(video_id)
        return iter(())

    monkeypatch.setattr(song_downloads, "_start_ytdlp_mp3_stream", stream_mp3)

    async with client:
        response = await client.post(
            "/downloads/song",
            json={"videoId": "audius-KlK59", "title": "Track", "rightsConfirmed": True},
        )

    assert response.status_code == 422
    assert started == []


def test_ytdlp_command_includes_configured_cookie_file(monkeypatch, tmp_path):
    cookiefile = tmp_path / "cookies.txt"
    cookiefile.write_text("# Netscape HTTP Cookie File")
    monkeypatch.setattr(song_downloads, "ytdlp_cookie_cli_args", lambda: ["--cookies", str(cookiefile)])
    monkeypatch.setattr(song_downloads.shutil, "which", lambda name: f"/usr/bin/{name}")

    command = song_downloads._ytdlp_command("6rOCiszTz-I")

    assert command[command.index("--cookies") + 1] == str(cookiefile)
    assert command[-1] == "https://www.youtube.com/watch?v=6rOCiszTz-I"


def test_ytdlp_and_ffmpeg_use_only_pipes_and_stdout(monkeypatch):
    monkeypatch.setattr(song_downloads.shutil, "which", lambda name: f"/usr/bin/{name}")

    ytdlp = song_downloads._ytdlp_command("6rOCiszTz-I")
    ffmpeg = song_downloads._ffmpeg_command()

    assert ytdlp[0] == "/usr/bin/yt-dlp"
    assert ytdlp[ytdlp.index("--output") + 1] == "-"
    assert ytdlp[-1] == "https://www.youtube.com/watch?v=6rOCiszTz-I"
    assert "pipe:0" in ffmpeg
    assert "pipe:1" in ffmpeg
    assert ffmpeg[ffmpeg.index("-f") + 1] == "mp3"
    assert not any(argument.endswith(".mp3") for argument in ytdlp + ffmpeg)


@pytest.mark.asyncio
async def test_download_releases_concurrency_slot_when_request_is_cancelled():
    starting_slots = song_downloads._download_semaphore._value

    async def cancel_stream(video_id):
        raise asyncio.CancelledError

    original = song_downloads._start_ytdlp_mp3_stream
    song_downloads._start_ytdlp_mp3_stream = cancel_stream
    try:
        payload = song_downloads.SongDownloadRequest(
            videoId="6rOCiszTz-I",
            title="Track",
            rightsConfirmed=True,
        )
        with pytest.raises(asyncio.CancelledError):
            await song_downloads.download_song(payload, TEST_USER)
    finally:
        song_downloads._start_ytdlp_mp3_stream = original

    assert song_downloads._download_semaphore._value == starting_slots


def test_process_stderr_sanitizer_keeps_error_and_redacts_secrets():
    raw = (
        "ERROR: [youtube] piUHBTXsoiY: Sign in to confirm you’re not a bot\n"
        "Request URL: https://youtube.example/watch?v=abc&sig=private-signature\n"
        "Authorization: Bearer private-access-token\n"
        "Cookie: SID=private-cookie; HSID=another-private-cookie\n"
    )

    diagnostic = song_downloads._sanitize_process_stderr(raw)

    assert "Sign in to confirm you’re not a bot" in diagnostic
    assert "[URL REDACTED]" in diagnostic
    assert "https://" not in diagnostic
    assert "private-signature" not in diagnostic
    assert "private-access-token" not in diagnostic
    assert "private-cookie" not in diagnostic
    assert "another-private-cookie" not in diagnostic


@pytest.mark.asyncio
async def test_process_stderr_capture_is_bounded_and_sanitized():
    class FakeReader:
        def __init__(self, chunks):
            self.chunks = iter(chunks)

        async def read(self, size):
            return next(self.chunks, b"")

    stream = FakeReader([b"x" * 9000, b"ERROR: HTTP Error 403: Forbidden\n"])

    diagnostic = await song_downloads._capture_process_stderr(stream)

    assert "HTTP Error 403: Forbidden" in diagnostic
    assert len(diagnostic) <= song_downloads.MAX_LOG_DIAGNOSTIC_CHARS


@pytest.mark.asyncio
async def test_ytdl_go_download_uses_isolated_provider_route(client, monkeypatch):
    started = []

    async def stream_mp3(video_id, provider="yt-dlp"):
        started.append((video_id, provider))

        async def chunks():
            yield b"ID3-go-mp3"

        return chunks()

    monkeypatch.setattr(song_downloads.os.path, "isfile", lambda path: True)
    monkeypatch.setattr(song_downloads, "_start_ytdlp_mp3_stream", stream_mp3)

    async with client:
        response = await client.post(
            "/downloads/song/ytdl-go",
            json={
                "videoId": "6rOCiszTz-I",
                "title": "Go resolver test",
                "rightsConfirmed": True,
            },
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["x-download-provider"] == "ytdl-go"
    assert response.content == b"ID3-go-mp3"
    assert started == [("6rOCiszTz-I", "ytdl-go")]
