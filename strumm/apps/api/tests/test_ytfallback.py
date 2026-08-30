"""Tests for the YouTube search fallback providers (ytfallback + wiring)."""

from unittest.mock import patch

import pytest

import app.services.ytmusic as yt
from app.services.ytmusic import YTSearchOutcome


class TestYTSearchOutcomeFallback:
    """verify _apply_search_fallback wiring in ytmusic.py."""

    def test_non_fallback_status_passes_through(self):
        outcome = YTSearchOutcome(found=False, status="ok", reason="no results")
        result = yt._apply_search_fallback(outcome, "q", "songs")
        assert result is outcome

    def test_rate_limited_not_treated_as_fallback(self):
        outcome = YTSearchOutcome(found=False, status="rate_limited", reason="429")
        result = yt._apply_search_fallback(outcome, "q", "songs")
        assert result is outcome

    def test_unreachable_kept_when_no_provider_results(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback", lambda q, **k: []
        )
        outcome = YTSearchOutcome(found=False, status="unreachable", reason="blocked")
        result = yt._apply_search_fallback(outcome, "q", "songs")
        assert result is outcome
        assert result.status == "unreachable"

    def test_unreachable_upgraded_to_ok_on_fallback_results(self, monkeypatch):
        fake_results = [{"videoId": "abc12345678", "title": "t", "artist": "a"}]
        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback", lambda q, **k: fake_results
        )
        outcome = YTSearchOutcome(found=False, status="unreachable", reason="blocked")
        result = yt._apply_search_fallback(outcome, "The Song", "songs")
        assert result.status == "ok"
        assert result.found is True
        assert result.results == fake_results
        assert "unreachable" in result.reason

    def test_non_song_filter_skips_fallback(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.ytfallback.search_fallback", lambda q, **k: [{"videoId": "x"}]
        )
        outcome = YTSearchOutcome(found=False, status="unreachable", reason="blocked")
        result = yt._apply_search_fallback(outcome, "Some Album", "albums")
        assert result is outcome


class TestYtfallbackModule:
    def test_module_imports(self):
        import app.services.ytfallback as fb
        assert hasattr(fb, "search_fallback")

    def test_ytdata_disabled_without_key(self, monkeypatch):
        import app.services.ytfallback as fb
        monkeypatch.setattr(fb, "YOUTUBE_API_KEY", "")
        assert fb._ytdata_enabled() is False
        assert fb.ytdata_search("q") == []

    def test_ytdata_search_normalizes_results(self, monkeypatch):
        import app.services.ytfallback as fb
        monkeypatch.setattr(fb, "YOUTUBE_API_KEY", "KEY")
        fake_items = [{
            "id": {"videoId": "abc12345678"},
            "snippet": {
                "title": "My Song",
                "channelTitle": "The Artist",
                "thumbnails": {
                    "medium": {"url": "https://img.example/med.jpg"},
                    "high": {"url": "https://img.example/hi.jpg"},
                },
            },
        }]
        payload = {"items": fake_items}
        with patch.object(
            fb.requests, "get"
        ) as mock_get:
            mock_get.return_value.status_code = 200
            mock_get.return_value.json.return_value = payload
            results = fb.ytdata_search("my song")

        assert len(results) == 1
        r = results[0]
        assert r["videoId"] == "abc12345678"
        assert r["title"] == "My Song"
        assert r["artists"] == [{"name": "The Artist"}]
        assert r["artist"] == "The Artist"
        assert r["thumbnails"] == [{"url": "https://img.example/med.jpg"}]
        assert r["duration_seconds"] == 0
        # request must include the api key
        called_params = mock_get.call_args.kwargs["params"]
        assert called_params["key"] == "KEY"

    def test_ytdata_403_returns_empty(self, monkeypatch):
        import app.services.ytfallback as fb
        monkeypatch.setattr(fb, "YOUTUBE_API_KEY", "KEY")
        with patch.object(fb.requests, "get") as mock_get:
            mock_get.return_value.status_code = 403
            mock_get.return_value.text = "quota exceeded"
            assert fb.ytdata_search("q") == []

    def test_ytdata_network_error_returns_empty(self, monkeypatch):
        import app.services.ytfallback as fb
        monkeypatch.setattr(fb, "YOUTUBE_API_KEY", "KEY")
        with patch.object(fb.requests, "get", side_effect=Exception("boom")):
            assert fb.ytdata_search("q") == []

    def test_ytdlp_search_normalizes_results(self, monkeypatch):
        import app.services.ytfallback as fb
        fake_entries = [{
            "id": "ddJUK4Y1ZTrY",  # 13-char id
            "title": "Cool Track",
            "uploader": "Some Artist",
            "duration": 278,
            "thumbnails": [
                {"url": "https://a.example/small.jpg", "width": 120, "height": 90},
                {"url": "https://a.example/big.jpg", "width": 480, "height": 360},
            ],
        }]
        fake_extract = {"entries": fake_entries}

        class FakeYDL:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def extract_info(self, query, download=False):
                assert query.startswith("ytsearch8:")
                return fake_extract

        with patch.object(fb, "_ytdlp_available", return_value=True), \
             patch.dict("sys.modules", {"yt_dlp": type(
                 "yt_dlp", (), {"YoutubeDL": FakeYDL}
             )}):
            results = fb.ytdlp_search("cool track")

        assert len(results) == 1
        r = results[0]
        assert r["videoId"] == "ddJUK4Y1ZTrY"
        assert r["title"] == "Cool Track"
        assert r["artists"] == [{"name": "Some Artist"}]
        # prefer the largest thumbnail
        assert r["thumbnails"][0]["url"] == "https://a.example/big.jpg"
        assert r["duration_seconds"] == 278
        assert r["duration"] == "4:38"

    def test_ytdlp_skips_non_video_ids(self, monkeypatch):
        import app.services.ytfallback as fb
        fake_entries = [
            {"id": "not valid id!", "title": "bad"},
            {"id": "abc12345678", "title": "good", "duration": 200,
             "thumbnails": [{"url": "https://x/y.jpg"}]},
        ]
        fake_extract = {"entries": fake_entries}

        class FakeYDL:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def extract_info(self, query, download=False):
                return fake_extract

        with patch.object(fb, "_ytdlp_available", return_value=True), \
             patch.dict("sys.modules", {"yt_dlp": type(
                 "yt_dlp", (), {"YoutubeDL": FakeYDL}
             )}):
            results = fb.ytdlp_search("song")
        assert len(results) == 1
        assert results[0]["videoId"] == "abc12345678"

    def test_ytdlp_unavailable_returns_empty(self, monkeypatch):
        import app.services.ytfallback as fb
        monkeypatch.setattr(fb, "_ytdlp_available", lambda: False)
        assert fb.ytdlp_search("q") == []

    def test_fallback_chain_tries_ytdata_then_ytdlp(self, monkeypatch):
        import app.services.ytfallback as fb
        ytdata_calls = []
        ytdlp_calls = []

        def fake_ytdata(q, **k):
            ytdata_calls.append(q)
            return []

        def fake_ytdlp(q, **k):
            ytdlp_calls.append(q)
            return [{"videoId": "abc12345678", "title": "t"}]

        monkeypatch.setattr(fb, "ytdata_search", fake_ytdata)
        monkeypatch.setattr(fb, "ytdlp_search", fake_ytdlp)
        results = fb.search_fallback("my query")
        assert ytdata_calls == ["my query"]
        assert ytdlp_calls == ["my query"]
        assert len(results) == 1

    def test_fallback_stops_when_ytdata_has_results(self, monkeypatch):
        import app.services.ytfallback as fb
        ytdlp_calls = []

        def fake_ytdata(q, **k):
            return [{"videoId": "abc12345678", "title": "t"}]

        def fake_ytdlp(q, **k):
            ytdlp_calls.append(q)
            return [{"videoId": "zzz"}]

        monkeypatch.setattr(fb, "ytdata_search", fake_ytdata)
        monkeypatch.setattr(fb, "ytdlp_search", fake_ytdlp)
        results = fb.search_fallback("q")
        assert ytdlp_calls == []
        assert results[0]["videoId"] == "abc12345678"
