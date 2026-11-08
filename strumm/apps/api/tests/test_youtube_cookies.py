import base64
import gzip
import json
import os
import stat

import pytest

from app.services import youtube_cookies


@pytest.fixture(autouse=True)
def clear_cookie_cache():
    youtube_cookies.get_ytdlp_cookiefile.cache_clear()
    yield
    cookiefile = youtube_cookies.get_ytdlp_cookiefile()
    if cookiefile and cookiefile.startswith("/tmp/strumm-ytdlp-cookies-"):
        try:
            os.unlink(cookiefile)
        except FileNotFoundError:
            pass
    youtube_cookies.get_ytdlp_cookiefile.cache_clear()


def _export():
    return [
        {
            "domain": ".youtube.com",
            "expirationDate": 1900000000,
            "httpOnly": True,
            "name": "__Secure-1PSID",
            "path": "/",
            "secure": True,
            "value": "test-session-value",
        },
        {
            "domain": ".youtube.com",
            "expirationDate": 1900000000,
            "httpOnly": False,
            "name": "VISITOR_INFO1_LIVE",
            "path": "/",
            "secure": True,
            "value": "test-visitor-value",
        },
        {
            "domain": ".example.com",
            "expirationDate": 1900000000,
            "name": "unrelated",
            "path": "/",
            "secure": True,
            "value": "must-not-be-copied",
        },
    ]


def test_json_cookie_export_is_materialized_as_youtube_only_netscape_file(monkeypatch):
    raw = json.dumps(_export()).encode()
    monkeypatch.setenv(
        youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV,
        base64.b64encode(raw).decode(),
    )
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, raising=False)

    cookiefile = youtube_cookies.get_ytdlp_cookiefile()

    assert cookiefile
    content = open(cookiefile, encoding="utf-8").read()
    assert content.startswith("# Netscape HTTP Cookie File\n")
    assert "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\t__Secure-1PSID\ttest-session-value" in content
    assert ".youtube.com\tTRUE\t/\tTRUE\t1900000000\tVISITOR_INFO1_LIVE\ttest-visitor-value" in content
    assert "must-not-be-copied" not in content
    assert stat.S_IMODE(os.stat(cookiefile).st_mode) == 0o600


def test_gzip_compressed_json_cookie_secret_is_supported(monkeypatch):
    raw = json.dumps(_export()).encode()
    compressed = gzip.compress(raw)
    monkeypatch.setenv(
        youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV,
        base64.b64encode(compressed).decode(),
    )
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, raising=False)

    cookiefile = youtube_cookies.get_ytdlp_cookiefile()

    assert cookiefile
    content = open(cookiefile, encoding="utf-8").read()
    assert "test-session-value" in content
    assert "must-not-be-copied" not in content
    assert stat.S_IMODE(os.stat(cookiefile).st_mode) == 0o600


def test_json_cookie_file_path_is_supported(monkeypatch, tmp_path):
    source = tmp_path / "cookie.json"
    source.write_text(json.dumps(_export()), encoding="utf-8")
    monkeypatch.setenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, str(source))
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV, raising=False)

    cookiefile = youtube_cookies.get_ytdlp_cookiefile()

    assert cookiefile
    assert "test-session-value" in open(cookiefile, encoding="utf-8").read()


def test_netscape_cookie_file_path_is_passed_through(monkeypatch, tmp_path):
    source = tmp_path / "cookies.txt"
    source.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR\tvalue\n")
    monkeypatch.setenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, str(source))
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV, raising=False)

    assert youtube_cookies.get_ytdlp_cookiefile() == str(source)


def test_no_cookie_configuration_preserves_anonymous_behavior(monkeypatch):
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, raising=False)
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV, raising=False)

    assert youtube_cookies.get_ytdlp_cookiefile() is None
    assert youtube_cookies.ytdlp_cookie_options() == {}
    assert youtube_cookies.ytdlp_cookie_cli_args() == []


def test_stream_extractor_passes_cookiefile_to_ytdlp(monkeypatch):
    import sys
    from types import SimpleNamespace
    from app.routes import stream

    captured = []

    class FakeYoutubeDL:
        def __init__(self, options):
            captured.append(options)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def extract_info(self, url, download=False):
            return {"url": "https://audio.example/test.m4a"}

    monkeypatch.setitem(sys.modules, "yt_dlp", SimpleNamespace(YoutubeDL=FakeYoutubeDL))
    monkeypatch.setattr(stream, "ytdlp_cookie_options", lambda: {"cookiefile": "/run/secrets/youtube-cookies.txt"})

    info = stream._run_ytdlp_extract("abc123def45")

    assert info["url"] == "https://audio.example/test.m4a"
    assert captured[0]["cookiefile"] == "/run/secrets/youtube-cookies.txt"


def test_invalid_base64_fails_closed_without_exposing_secret(monkeypatch, caplog):
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, raising=False)
    monkeypatch.setenv(youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV, "not-base64")

    assert youtube_cookies.get_ytdlp_cookiefile() is None
    assert "not-base64" not in caplog.text


def test_cookie_secret_is_loaded_from_aws_secrets_manager(monkeypatch):
    from types import SimpleNamespace
    import sys

    raw = json.dumps(_export()).encode()
    encoded = base64.b64encode(raw).decode()
    calls = {}

    class FakeSecretsManager:
        def get_secret_value(self, **kwargs):
            calls.update(kwargs)
            return {"SecretString": encoded}

    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_FILE_ENV, raising=False)
    monkeypatch.delenv(youtube_cookies.YTDLP_COOKIES_JSON_B64_ENV, raising=False)
    monkeypatch.setenv("AWS_REGION", "ap-southeast-2")
    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda service, region_name: FakeSecretsManager()))

    cookiefile = youtube_cookies.get_ytdlp_cookiefile()

    assert cookiefile
    assert calls == {"SecretId": "strumm/prod/youtube-cookies"}
    assert "test-session-value" in open(cookiefile, encoding="utf-8").read()
