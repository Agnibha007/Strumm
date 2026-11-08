import os
import subprocess
import sys
from pathlib import Path


def test_hokas_profile_keeps_core_api_and_blocks_media_delivery():
    api_dir = Path(__file__).resolve().parents[1]
    script = r'''
import sys
from fastapi.testclient import TestClient
from app.main import HOKAS_PROFILE, app

assert HOKAS_PROFILE is True
assert "app.routes.stream" not in sys.modules
assert "app.routes.song_downloads" not in sys.modules
client = TestClient(app)
assert client.get("/health").status_code == 200
assert client.get("/auth/sessions").status_code == 401
assert client.get("/playlists/search").status_code == 422
assert client.get("/yt/search").status_code == 422
assert client.post("/downloads/song", json={}).status_code == 501
assert client.get("/yt/streams/abcdefghijk").status_code == 501
assert client.get("/audius/tracks/123/stream").status_code == 501
assert client.get("/podcasts/episode/123/download").status_code == 501
assert client.get("/play/abcdefghijk").status_code == 501
assert client.get("/audio-proxy").status_code == 501
'''
    env = os.environ.copy()
    env.update({
        "HOKAS_PROFILE": "1",
        "ENVIRONMENT": "production",
        "MONGODB_URI": "mongodb://127.0.0.1:27017/hokas-test",
        "JWT_SECRET": "test-only-secret",
    })
    subprocess.run(
        [sys.executable, "-c", script],
        cwd=api_dir,
        env=env,
        check=True,
        timeout=30,
    )
