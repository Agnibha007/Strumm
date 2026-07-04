"""
Tests for the /radio/{video_id} endpoint.

Tests the full fallback chain, exclude param filtering, and radio_logs persistence.
Dependencies (YTMusic, MongoDB) are mocked so tests run without external services.
Uses httpx.AsyncClient with ASGITransport directly to avoid starlette TestClient
compatibility issues with httpx 0.28+.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db():
    """Mock the MongoDB database."""
    db = MagicMock()
    db.PLAYLISTS = "playlists"
    db.LIKED_SONGS = "likedSongs"
    db.PLAYBACK_HISTORIES = "playbackHistories"
    db.USERS = "users"

    # Default: no radio_logs for the user
    db.__getitem__.return_value.find_one = AsyncMock(return_value=None)
    db.__getitem__.return_value.update_one = AsyncMock()
    db.__getitem__.return_value.delete_many = AsyncMock()

    # Playlist aggregation: default empty
    playlist_cursor = AsyncMock()
    playlist_cursor.__aiter__.return_value = iter([])
    db[db.PLAYLISTS].aggregate = MagicMock(return_value=playlist_cursor)

    return db


@pytest.fixture
def mock_ytmusic():
    """Mock YTMusic call_ytmusic_safe."""
    with patch("app.services.ytmusic.call_ytmusic_safe") as mock:
        yield mock


@pytest.fixture
def mock_find_song():
    """Mock find_song_in_db."""
    with patch("app.services.song_lookup.find_song_in_db") as mock:
        yield mock


@pytest.fixture
def client(mock_db):
    """Create a httpx AsyncClient pointed at the FastAPI app."""
    from app.database import mongodb
    mongodb.get_db = MagicMock(return_value=mock_db)

    from app.main import app as _app
    from app.routes.dependencies import get_current_user

    # Override auth dependency to return a test user
    async def mock_get_current_user():
        return {
            "id": "test_user_123",
            "username": "testuser",
            "email": "test@example.com",
            "createdAt": "2025-01-01T00:00:00",
        }

    _app.dependency_overrides[get_current_user] = mock_get_current_user

    from httpx import ASGITransport, AsyncClient
    transport = ASGITransport(app=_app)
    return AsyncClient(transport=transport, base_url="http://test")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_TRACKS = [
    {
        "videoId": "related1",
        "title": "Related Track 1",
        "artists": [{"name": "Artist A"}],
        "length": 210,
        "thumbnail": [{"url": "https://img.youtube.com/vi/related1/hqdefault.jpg"}],
    },
    {
        "videoId": "related2",
        "title": "Related Track 2",
        "artists": [{"name": "Artist B"}],
        "length": 195,
        "thumbnail": [{"url": "https://img.youtube.com/vi/related2/hqdefault.jpg"}],
    },
]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRadioPrimarySource:
    """Radio uses YTMusic watch playlist as primary source."""

    @pytest.mark.asyncio
    async def test_returns_tracks_from_watch_playlist(self, client, mock_ytmusic):
        """Happy path: YTMusic returns tracks, they are mapped correctly."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert resp.status_code == 200
        assert data["success"] is True
        assert len(data["data"]["songs"]) == 2
        assert data["data"]["seed"] == "testSeed"
        assert data["data"]["total"] == 2

        song = data["data"]["songs"][0]
        assert song["videoId"] == "related1"
        assert song["title"] == "Related Track 1"
        assert song["artist"] == "Artist A"
        assert song["duration"] == 210

    @pytest.mark.asyncio
    async def test_excludes_seed_video_id(self, client, mock_ytmusic):
        """The seed videoId is always excluded from results."""
        tracks = SAMPLE_TRACKS + [{
            "videoId": "testSeed",
            "title": "Seed Track",
            "artists": [{"name": "Artist S"}],
            "length": 200,
        }]
        mock_ytmusic.return_value = {"tracks": tracks}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        video_ids = [s["videoId"] for s in data["data"]["songs"]]
        assert "testSeed" not in video_ids
        assert len(data["data"]["songs"]) == 2

    @pytest.mark.asyncio
    async def test_handles_missing_artists_gracefully(self, client, mock_ytmusic):
        """Tracks without artists are handled gracefully."""
        mock_ytmusic.return_value = {
            "tracks": [
                {
                    "videoId": "vid1",
                    "title": "No Artist Track",
                    "length": 200,
                },
            ]
        }

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        assert data["data"]["songs"][0]["artist"] == "Unknown Artist"

    @pytest.mark.asyncio
    async def test_handles_missing_thumbnail(self, client, mock_ytmusic):
        """Tracks without thumbnails fall back to YouTube default."""
        mock_ytmusic.return_value = {
            "tracks": [
                {
                    "videoId": "vid1",
                    "title": "Track",
                    "artists": [{"name": "Artist"}],
                    "length": 200,
                },
            ]
        }

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        assert data["data"]["songs"][0]["thumbnail"] == \
            "https://img.youtube.com/vi/vid1/hqdefault.jpg"


class TestRadioFallbackChain:
    """Radio falls back through multiple sources when primary fails."""

    @pytest.mark.asyncio
    async def test_fallback_to_db_artist_lookup(
        self, client, mock_ytmusic, mock_find_song, mock_db
    ):
        """When YTMusic fails, falls back to DB songs by same artist."""
        mock_ytmusic.return_value = None
        mock_find_song.return_value = {
            "videoId": "testSeed",
            "title": "Seed Song",
            "artist": "Test Artist",
            "thumbnail": "",
            "duration": 200,
        }

        # Mock playlist aggregation to return some songs
        db_songs = [
            {"videoId": "db1", "title": "DB Song 1", "artist": "Test Artist",
             "thumbnail": "", "duration": 180},
            {"videoId": "db2", "title": "DB Song 2", "artist": "Test Artist",
             "thumbnail": "", "duration": 200},
        ]
        playlist_cursor = AsyncMock()
        playlist_cursor.__aiter__.return_value = iter(db_songs)
        mock_db[mock_db.PLAYLISTS].aggregate = MagicMock(return_value=playlist_cursor)

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        assert len(data["data"]["songs"]) == 2
        assert data["data"]["songs"][0]["videoId"] == "db1"

    @pytest.mark.asyncio
    async def test_fallback_to_ytmusic_search(
        self, client, mock_ytmusic, mock_find_song, mock_db
    ):
        """When DB artist lookup fails, falls back to YTMusic search."""
        mock_ytmusic.return_value = None
        mock_find_song.return_value = {
            "videoId": "testSeed",
            "title": "Seed Song",
            "artist": "Unique Artist",
            "thumbnail": "",
            "duration": 200,
        }

        # DB artist lookup returns nothing
        empty_cursor = AsyncMock()
        empty_cursor.__aiter__.return_value = iter([])
        mock_db[mock_db.PLAYLISTS].aggregate = MagicMock(return_value=empty_cursor)

        # Mock search_yt_music_songs at its source module
        with patch("app.routes.search.search_yt_music_songs",
                   new_callable=AsyncMock) as mock_search:
            mock_search.return_value = [
                {"videoId": "search1", "title": "Search Result 1",
                 "artist": "Found Artist", "thumbnail": "",
                 "duration": 190},
            ]

            async with client:
                resp = await client.get("/radio/testSeed?limit=10")
                data = resp.json()

            assert data["success"] is True, f"Expected success but got: {data}"
            assert len(data["data"]["songs"]) == 1
            assert data["data"]["songs"][0]["videoId"] == "search1"

    @pytest.mark.asyncio
    async def test_fallback_to_random_db_sampling(
        self, client, mock_ytmusic, mock_find_song, mock_db
    ):
        """When all other sources fail, falls back to random DB sampling."""
        mock_ytmusic.return_value = None
        mock_find_song.return_value = None

        # The aggregate() is called twice: first for artist lookup (seed_song is None,
        # so the `if not radio_songs and seed_song:` block is skipped), then for
        # Fallback 3 random sampling (the `if not radio_songs:` block).
        db_cursor = AsyncMock()
        db_cursor.__aiter__.return_value = iter([
            {"videoId": "rand1", "title": "Random Song 1",
             "artist": "Random Artist", "thumbnail": "", "duration": 200},
        ])
        mock_db[mock_db.PLAYLISTS].aggregate = MagicMock(return_value=db_cursor)

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True, f"Expected success but got: {data}"
        assert len(data["data"]["songs"]) == 1
        assert data["data"]["songs"][0]["videoId"] == "rand1"

    @pytest.mark.asyncio
    async def test_returns_error_when_all_sources_exhausted(
        self, client, mock_ytmusic, mock_find_song, mock_db
    ):
        """When all sources fail, returns a clear error."""
        mock_ytmusic.return_value = None
        mock_find_song.return_value = None

        empty_cursor = AsyncMock()
        empty_cursor.__aiter__.return_value = iter([])
        mock_db[mock_db.PLAYLISTS].aggregate = MagicMock(return_value=empty_cursor)

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is False
        assert "No related tracks found" in data["error"]


class TestRadioExcludeParam:
    """The exclude query param filters out specified videoIds."""

    @pytest.mark.asyncio
    async def test_excludes_provided_video_ids(self, client, mock_ytmusic):
        """videoIds passed in exclude param are filtered out."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10&exclude=related1")
            data = resp.json()

        assert data["success"] is True
        assert len(data["data"]["songs"]) == 1
        assert data["data"]["songs"][0]["videoId"] == "related2"

    @pytest.mark.asyncio
    async def test_excludes_multiple_ids(self, client, mock_ytmusic):
        """Multiple comma-separated videoIds are all excluded."""
        tracks = SAMPLE_TRACKS + [
            {
                "videoId": "related3",
                "title": "Related Track 3",
                "artists": [{"name": "Artist C"}],
                "length": 200,
            },
        ]
        mock_ytmusic.return_value = {"tracks": tracks}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10&exclude=related1,related2")
            data = resp.json()

        assert data["success"] is True
        assert len(data["data"]["songs"]) == 1
        assert data["data"]["songs"][0]["videoId"] == "related3"

    @pytest.mark.asyncio
    async def test_empty_exclude_param_is_ignored(self, client, mock_ytmusic):
        """Empty exclude param does not affect results."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10&exclude=")
            data = resp.json()

        assert data["success"] is True
        assert len(data["data"]["songs"]) == 2


class TestRadioLogsPersistence:
    """Radio recommendations are persisted for cross-session freshness."""

    @pytest.mark.asyncio
    async def test_persists_recommended_tracks(self, client, mock_ytmusic, mock_db):
        """Recommended track videoIds are saved to radio_logs."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            assert resp.status_code == 200

        # Verify update_one was called on radio_logs
        radio_logs = mock_db["radio_logs"]
        assert radio_logs.update_one.called

        # update_one is called with positional args: (filter, update, upsert=True)
        call_args, call_kwargs = radio_logs.update_one.call_args
        # The second positional arg is the update document
        update = call_args[1] if len(call_args) > 1 else call_kwargs.get("update", {})

        push_op = update.get("$push", {})
        video_ids_op = push_op.get("videoIds", {})
        assert "related1" in video_ids_op.get("$each", [])
        assert "related2" in video_ids_op.get("$each", [])
        assert video_ids_op.get("$slice") == -300

    @pytest.mark.asyncio
    async def test_excludes_from_radio_logs(self, client, mock_ytmusic, mock_db):
        """Previously recommended tracks from radio_logs are excluded."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        # Simulate radio_logs existing with a previously recommended track
        async def find_one_side_effect(filter_dict, projection=None):
            if "radio_logs" in str(filter_dict) or filter.get("userId"):
                return {"videoIds": ["related1"]}
            return None

        mock_db.__getitem__.return_value.find_one = AsyncMock(
            side_effect=lambda filter_dict, projection=None: (
                {"videoIds": ["related1"]}
                if "radio_logs" in str(filter_dict) or (isinstance(filter_dict, dict) and "userId" in filter_dict)
                else None
            )
        )

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        # related1 was in radio_logs, so only related2 should remain
        assert len(data["data"]["songs"]) == 1
        assert data["data"]["songs"][0]["videoId"] == "related2"

    @pytest.mark.asyncio
    async def test_handles_missing_radio_logs(self, client, mock_ytmusic, mock_db):
        """When radio_logs don't exist, all tracks are returned normally."""
        mock_ytmusic.return_value = {"tracks": SAMPLE_TRACKS}

        async with client:
            resp = await client.get("/radio/testSeed?limit=10")
            data = resp.json()

        assert data["success"] is True
        assert len(data["data"]["songs"]) == 2
