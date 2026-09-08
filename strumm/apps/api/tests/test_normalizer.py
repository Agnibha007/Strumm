"""
Tests for display normalization at the consumer / emission boundary.

Covers ``normalize_song_display()`` — the single helper applied when fresh
provider metadata becomes a persisted ``Song`` or a response item. Focus is
precision: confident artist-prefix splits happen, but false positives are
left untouched, the helper is idempotent on already-persisted shapes, and
DB-matched songs returned on read are NOT re-normalized.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.normalizer import (
    canonical_song_key,
    clean_song_display_title,
    extract_artist_prefix,
    normalize_song_display,
)
from app.routes.recommendation import resolve_suggestions


# ---------------------------------------------------------------------------
# 1. Confident artist-prefix splits (frontend parity)
# ---------------------------------------------------------------------------


def test_collaboration_prefix_split_uses_structured_artists():
    item = {
        "videoId": "v1",
        "title": "Arijit Singh, Pritam - Ae Dil Hai Mushkil",
        "artists": [{"name": "Arijit Singh"}, {"name": "Pritam"}],
        "album": "Ae Dil Hai Mushkil",
        "duration": 200,
    }
    out = normalize_song_display(item)
    assert out["title"] == "Ae Dil Hai Mushkil"
    assert out["artist"] == "Arijit Singh, Pritam"
    assert out["videoId"] == "v1"
    assert out["album"] == "Ae Dil Hai Mushkil"


def test_single_artist_prefix_split_preserves_casing():
    assert normalize_song_display({
        "title": "KK - Aankhon Mein Teri",
        "artists": [{"name": "KK"}],
    })["title"] == "Aankhon Mein Teri"
    assert normalize_song_display({
        "title": "Pritam - Phir Le Aaya Dil",
        "artists": [{"name": "Pritam"}],
    })["artist"] == "Pritam"


def test_prefix_split_artist_comes_from_title_when_no_structured_artists():
    out = normalize_song_display({
        "title": "KK - Aankhon Mein Teri",
        "artist": "",
    })
    assert out["title"] == "Aankhon Mein Teri"
    assert out["artist"] == "KK"


# ---------------------------------------------------------------------------
# 2. Official / metadata noise cleaning
# ---------------------------------------------------------------------------


def test_official_music_video_cleaned_from_bracket():
    out = normalize_song_display({
        "title": "Young, Wild and Free (Official Music Video)",
        "artists": [{"name": "SnoopDoggVEVO"}],
    })
    assert out["title"] == "Young, Wild and Free"
    assert out["artist"] == "Snoop Dogg"


def test_vevo_channel_inference_with_camel_split():
    out = normalize_song_display({
        "title": "Young, Wild and Free",
        "channel": "SnoopDoggVEVO",
    })
    assert out["title"] == "Young, Wild and Free"
    assert out["artist"] == "Snoop Dogg"


def test_clean_song_display_title_handles_pipe_suffix_and_emoji():
    assert clean_song_display_title("Believer") == "Believer"
    assert clean_song_display_title("Believer | ImagineDragonsVEVO") == "Believer"
    assert clean_song_display_title("Tum Hi Ho 🔥") == "Tum Hi Ho"
    assert clean_song_display_title("Bones (Official Audio)") == "Bones"


# ---------------------------------------------------------------------------
# 3. False positives stay untouched
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "title",
    [
        "Love Me - Love Me",
        "One More Night - Remix",
        "Highway - A Love Story",
        "AC/DC - Thunderstruck",
        "Imagine Dragons - Believer - Remix",
    ],
)
def test_false_positive_titles_are_not_split(title):
    out = normalize_song_display({"title": title})
    assert out["title"] == title


def test_extract_artist_prefix_rejects_false_positives():
    assert extract_artist_prefix("Love Me - Love Me") is None
    assert extract_artist_prefix("One More Night - Remix") is None
    assert extract_artist_prefix("AC/DC - Thunderstruck") is None
    assert extract_artist_prefix("Imagine Dragons - Believer - Remix") is None


def test_extract_artist_prefix_accepts_confident_split():
    assert extract_artist_prefix("KK - Aankhon Mein Teri") == (
        "KK", "Aankhon Mein Teri",
    )


# ---------------------------------------------------------------------------
# 4. Idempotence + canonical consistency
# ---------------------------------------------------------------------------


def test_persisted_shape_is_idempotent():
    persisted = {"title": "Ae Dil Hai Mushkil", "artist": "Arijit Singh, Pritam"}
    assert normalize_song_display(persisted) == persisted


def test_radio_reply_shape_is_idempotent():
    reply = {"title": "Ae Dil Hai Mushkil", "artist": "Arijit Singh, Pritam"}
    assert normalize_song_display(reply) == reply


def test_canonical_key_derives_from_final_normalized_fields():
    out = normalize_song_display({
        "title": "Arijit Singh, Pritam - Ae Dil Hai Mushkil",
        "artists": [{"name": "Arijit Singh"}, {"name": "Pritam"}],
    })
    # Re-deriving the canonical key from the FINAL fields must be stable and
    # match what a persisted song would produce.
    assert canonical_song_key(out["title"], out["artist"]) == (
        canonical_song_key("Ae Dil Hai Mushkil", "Arijit Singh, Pritam")
    )


# ---------------------------------------------------------------------------
# 5. resolve_suggestions: fresh provider results normalized, DB results kept
# ---------------------------------------------------------------------------


def _mock_db_with_find(return_value):
    db = MagicMock()
    db.PLAYLISTS = "playlists"
    collection = MagicMock()
    collection.find_one = AsyncMock(return_value=return_value)
    db.__getitem__.return_value = collection
    return db


@pytest.mark.asyncio
async def test_resolve_suggestions_normalizes_fresh_results(monkeypatch):
    db = _mock_db_with_find(None)  # no DB match -> falls through to search
    monkeypatch.setattr("app.routes.recommendation.db.get_db", lambda: db)

    async def fake_search(query):
        return [{
            "videoId": "srch1",
            "title": "KK - Aankhon Mein Teri",
            "artists": [{"name": "KK"}],
            "album": "Humraaz",
            "duration": 256,
        }]

    monkeypatch.setattr(
        "app.routes.search.search_yt_music_songs", fake_search
    )

    resolved = await resolve_suggestions([{"title": "Aankhon Mein Teri", "artist": "KK"}])
    assert len(resolved) == 1
    assert resolved[0]["videoId"] == "srch1"
    assert resolved[0]["title"] == "Aankhon Mein Teri"
    assert resolved[0]["artist"] == "KK"


@pytest.mark.asyncio
async def test_resolve_suggestions_leaves_db_matches_untouched(monkeypatch):
    stored = {
        "videoId": "db-song",
        "title": "Legacy - Raw Title",
        "artist": "Old Artist",
        "thumbnail": "t.jpg",
        "duration": 180,
    }
    db = _mock_db_with_find({"songs": [stored]})
    monkeypatch.setattr("app.routes.recommendation.db.get_db", lambda: db)

    async def fake_search(query):
        raise AssertionError("search must not run when the DB match wins")

    monkeypatch.setattr(
        "app.routes.search.search_yt_music_songs", fake_search
    )

    resolved = await resolve_suggestions([{"title": "Legacy Raw Title", "artist": "Old"}])
    assert len(resolved) == 1
    # DB songs returned on read are NOT re-normalized.
    assert resolved[0]["title"] == "Legacy - Raw Title"
    assert resolved[0]["artist"] == "Old Artist"