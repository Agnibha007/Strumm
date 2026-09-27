"""
Recommendation personalization.

These tests pin the signals that make a mix specific to *this* user. The
defects they cover were all silent — the engine still returned a full playlist,
just a generic one, so nothing errored and nothing looked obviously broken:

  * `statistics.topArtists` is written with the artist name under the key
    ``"artist"`` but was read from ``"name"``, yielding a list of empty strings.
    An empty string never matches an artist (so affinity scored nothing) and
    `re.escape("")` is an empty regex that matches EVERY playlist, turning the
    "playlists by my favourite artists" query into a global random sample.
  * Random noise of +/-1.0 — as large as the entire artist boost — dominated
    every real signal, so ranking was mostly noise.
  * Top genres were computed from history and threaded to the scorer, but the
    scorer never read them.
  * In discovery mode a track that had *already been played* was given a
    positive boost.
"""
import pytest

from app.services.recommendation_engine import RecommendationEngine


@pytest.fixture
def engine():
    return RecommendationEngine()


def song(vid, artist, title="Track", duration=200):
    return {
        "videoId": vid,
        "title": title,
        "artist": artist,
        "thumbnail": "",
        "duration": duration,
    }


def play(artist, title="Track", vid="v1", listened=200, duration=200):
    """A playback-history row, as stored by POST /play-event."""
    return {
        "song": {**song(vid, artist, title, duration)},
        "listenDuration": listened,
        "playedAt": None,
    }


def like(artist, vid="v1", title="Track"):
    return {"song": song(vid, artist, title), "likedAt": None}


# --- statistics.topArtists key handling --------------------------------------


class TestTopArtistExtraction:
    def test_reads_the_artist_key_the_stats_writer_actually_uses(self, engine):
        # This is the real document shape written by routes/user.py.
        entries = [
            {"artist": "Arijit Singh", "thumbnail": "t", "count": 9},
            {"artist": "Radiohead", "thumbnail": "t", "count": 4},
        ]
        assert engine._extract_top_artist_names(entries) == ["Arijit Singh", "Radiohead"]

    def test_falls_back_to_display_name_then_name(self, engine):
        assert engine._extract_top_artist_names(
            [{"display_name": "Nujabes"}, {"name": "Bonobo"}]
        ) == ["Nujabes", "Bonobo"]

    def test_accepts_plain_strings(self, engine):
        assert engine._extract_top_artist_names(["Miles Davis"]) == ["Miles Davis"]

    def test_drops_blanks_instead_of_propagating_them(self, engine):
        # The whole bug: these blanks became a `$regex: ""` that matched
        # every playlist, i.e. "recommend the entire catalogue at random".
        assert engine._extract_top_artist_names(
            [{"artist": ""}, {"artist": "   "}, {}, {"artist": None}, None, {"artist": "Sade"}]
        ) == ["Sade"]

    def test_deduplicates_case_and_suffix_variants(self, engine):
        entries = [{"artist": "Arijit Singh"}, {"artist": "ARIJIT SINGH"}, {"artist": "Arijit Singh Official"}]
        assert len(engine._extract_top_artist_names(entries)) == 1

    def test_handles_missing_and_empty_inputs(self, engine):
        assert engine._extract_top_artist_names([]) == []
        assert engine._extract_top_artist_names(None) == []


# --- Artist affinity: completion-weighted, not raw play counts ---------------


class TestArtistAffinity:
    def test_favours_artists_the_user_actually_finished(self, engine):
        candidates = [song("a", "Loved Artist"), song("b", "Skipped Artist")]
        # "Loved Artist" played to the end repeatedly; "Skipped Artist" barely
        # started. A raw play-count signal cannot tell these apart.
        history = [play("Loved Artist", vid="l1"), play("Loved Artist", vid="l2")]
        history += [play("Skipped Artist", vid="s1", listened=3)]

        scored = engine._score_candidates(candidates, [], history, [], "Chill")
        scores = {c["artist"]: s for c, s in scored}
        assert scores["Loved Artist"] > scores["Skipped Artist"]

    def test_engagement_scales_the_history_boost(self, engine):
        full = song("a", "X", duration=200)
        partial = song("b", "X", duration=200)
        history_full = [play("X", vid="a", listened=200, duration=200)]
        history_partial = [play("X", vid="b", listened=10, duration=200)]
        scores = {}
        for cand, hist in ((full, history_full), (partial, history_partial)):
            for c, s in engine._score_candidates([cand], [], hist, [], "Chill"):
                scores[c["videoId"]] = s
        assert scores["a"] > scores["b"]

    def test_top_artist_boost_now_actually_applies(self, engine):
        """Regression: a non-empty top-artist list must change the ranking.

        The list used to be five empty strings, so this boost never fired for
        anyone.
        """
        candidates = [song("a", "Someone Else"), song("b", "My Favourite")]
        history = []
        without = {c["videoId"]: s for c, s in engine._score_candidates(candidates, [], history, [], "Chill")}
        with_top = {
            c["videoId"]: s
            for c, s in engine._score_candidates(candidates, [], history, ["My Favourite"], "Chill")
        }
        # Only the favourite gains, and by roughly the artist boost.
        assert with_top["b"] - without["b"] == pytest.approx(2.0, abs=0.3)
        assert with_top["a"] == pytest.approx(without["a"], abs=0.3)
        # And it now actually outranks the non-favourite.
        ranked = [
            c["videoId"]
            for c, _ in engine._score_candidates(candidates, [], history, ["My Favourite"], "Chill")
        ]
        assert ranked[0] == "b"


# --- Discovery mode must favour unheard tracks -------------------------------


class TestDiscoveryMode:
    def test_already_heard_tracks_are_penalised_not_boosted(self, engine):
        heard = song("h", "Heard Artist")
        fresh = song("f", "Unheard Artist")
        history = [play("Heard Artist", vid="h")]

        scores = {
            c["videoId"]: s
            for c, s in engine._score_candidates(
                [heard, fresh], [], history, [], "Fresh & Undiscovered", discovery_boost=True
            )
        }
        # The regression: discovery mode used to ADD +0.5 for a track already in
        # history, so the more recently you listened the higher a played track
        # scored.
        assert scores["f"] > scores["h"]

    def test_penalty_is_discovery_only(self, engine):
        heard = song("h", "Heard Artist")
        fresh = song("f", "Unheard Artist")
        history = [play("Heard Artist", vid="h")]
        scores = {
            c["videoId"]: s
            for c, s in engine._score_candidates(
                [heard, fresh], [], history, [], "Chill", discovery_boost=False
            )
        }
        # A "Flow" mix legitimately leads with what the user just played.
        assert scores["h"] > scores["f"]


# --- Genre affinity is actually used -----------------------------------------


class TestGenreAffinity:
    def test_top_genres_influence_the_score(self, engine):
        # Radiohead classifies as "Alternative & Rock" in the normalizer.
        history = [play("Radiohead", vid="r1"), play("Radiohead", vid="r2"), play("Radiohead", vid="r3")]
        candidates = [song("a", "Radiohead"), song("b", "Totally Unknown Band")]
        base = {c["videoId"]: s for c, s in engine._score_candidates(candidates, [], [], [], "Chill")}
        with_history = {
            c["videoId"]: s for c, s in engine._score_candidates(candidates, [], history, [], "Chill")
        }
        assert with_history["a"] != pytest.approx(base["a"], abs=0.001)


# --- Liked songs and noise ---------------------------------------------------


class TestScoringBasics:
    def test_liked_songs_still_dominate_a_flow_mix(self, engine):
        candidates = [song("a", "Liked"), song("b", "Other")]
        likes = [like("Liked", vid="a")]
        ranked = [c["videoId"] for c, _ in engine._score_candidates(candidates, likes, [], [], "Chill")]
        assert ranked[0] == "a"

    def test_noise_is_small_enough_that_real_signal_wins(self, engine):
        """The old +/-1.0 jitter was as large as every real boost combined."""
        strong = song("a", "Strong")
        weak = song("b", "Weak")
        history = [play("Strong", vid="h1"), play("Strong", vid="h2"), play("Strong", vid="h3")]

        wins = 0
        for _ in range(50):
            ranked = [
                c["videoId"]
                for c, _ in engine._score_candidates([strong, weak], [], history, [], "Chill")
            ]
            if ranked[0] == "a":
                wins += 1
        assert wins == 50, "personalisation is being drowned out by jitter"

    def test_handles_missing_and_zero_duration_history(self, engine):
        # A corrupt row (no duration, no listenDuration) must not raise.
        history = [{"song": {"videoId": "x", "artist": "A", "title": "T"}, "listenDuration": None}]
        scored = engine._score_candidates([song("a", "A")], [], history, [], "Chill")
        assert len(scored) == 1

    def test_song_missing_artist_does_not_raise(self, engine):
        scored = engine._score_candidates([{"videoId": "a", "title": "T"}], [], [], [], "Chill")
        assert len(scored) == 1
