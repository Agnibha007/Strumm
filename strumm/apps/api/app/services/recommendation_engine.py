"""
RecommendationEngine — single source of truth for music recommendation generation.

Both the Home page (Discovery Mix) and Strumm Flow use this engine to produce
consistent, personalized results.  AI is only called as an *optional enhancement
layer* — if the AI provider is unavailable, times out, or returns an error, the
engine's output is returned as-is.

Architecture
------------
   User Request
        │
        ▼
  RecommendationEngine.generate()
        │
        ├── Listening History  ──┐
        ├── Liked Songs       ──┤──► Score & rank candidates
        ├── Top Artists       ──┤
        ├── Top Genres        ──┘
        ├── Recently Played
        ├── Similar Songs (by artist / genre)
        ├── Similar Artists (by co-listen)
        └── Diversity shuffle (prevent same-artist stacks)
        │
        ▼
  Candidate Songs (20–30 items)
        │
        ▼
  (Optional) AI Enhancement
        ├── Reorder for flow
        ├── Generate playlist name / description
        ├── Group by mood / energy
        └── Handle gracefully if AI is unavailable
        │
        ▼
  Final Flow Playlist (10-15 items)
"""

from __future__ import annotations

import asyncio
import random
import re
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from app.database import mongodb as db
from app.services.cache import cache_recommendation, get_cached_recommendation
from app.services.normalizer import canonical_artist, classify_genre

logger = logging.getLogger("strumm-recommendation-engine")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MOODS = [
    "Chill", "Energetic", "Focus", "Happy", "Sad",
    "Romantic", "Workout", "Party", "Travel", "Late Night",
    "Rainy Day", "Creative", "Sleep", "Nostalgia", "Fresh",
]

CANDIDATE_POOL_SIZE = 50
FINAL_PLAYLIST_SIZE = 15

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class RecommendationEngine:
    """Generates personalized music recommendations from user data."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def generate(
        self,
        user_id: str,
        *,
        mood: str = "Chill",
        limit: int = FINAL_PLAYLIST_SIZE,
        exclude_video_ids: set | None = None,
    ) -> dict[str, Any]:
        """
        Generate a personalized recommendation playlist.

        Returns
        -------
        A dict with keys: ``name``, ``description``, ``songs``, ``source``.
        ``source`` is ``"engine"`` if AI was not used, or ``"ai_enhanced"``
        if the AI enhancement layer was applied.
        """
        cache_key = f"rec:flow:{user_id}:{mood.lower()}"
        cached = get_cached_recommendation(cache_key)
        if cached:
            return cached

        database = db.get_db()
        exclude = exclude_video_ids or set()

        # ---- Step 1: Gather user profile data ----
        likes, history, stats, top_artists, top_genres = await self._gather_profile(
            database, user_id
        )

        # ---- Step 2: Build candidate pool ----
        candidates = await self._build_candidates(
            database, user_id, likes, history, stats,
            top_artists, top_genres, mood, exclude,
        )

        # ---- Step 3: Score, rank, and diversify ----
        scored = self._score_candidates(candidates, likes, history, top_artists, mood)
        final = self._diversify(scored, limit=limit)

        result = {
            "name": f"Flow: {mood}",
            "description": self._generate_description(mood, len(final), bool(top_artists)),
            "songs": final,
            "source": "engine",
        }

        cache_recommendation(cache_key, result)
        return result

    async def generate_discovery(
        self,
        user_id: str,
        *,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Generate a Discovery Mix (Home page)."""
        # Rotate the cache every 4 hours so the user doesn't see the same
        # recommendations all day.  The seed changes which random nudge
        # different candidates get, surfacing fresh variety.
        slot = datetime.utcnow().hour // 4
        cache_key = f"rec:discovery:{user_id}:{slot}"
        cached = get_cached_recommendation(cache_key)
        if cached:
            return cached

        database = db.get_db()
        likes, history, stats, top_artists, top_genres = await self._gather_profile(
            database, user_id
        )

        # Collect recently recommended videoIds to exclude for freshness
        recently_shown = await self._get_recently_recommended(database, user_id)

        candidates = await self._build_candidates(
            database, user_id, likes, history, stats,
            top_artists, top_genres, mood="Fresh & Undiscovered",
            exclude=recently_shown,
        )

        # Track which songs we're recommending for future exclusion
        await self._record_recommendations(database, user_id, candidates)

        scored = self._score_candidates(
            candidates, likes, history, top_artists, "Fresh & Undiscovered",
            discovery_boost=True,
        )
        final = self._diversify(scored, limit=limit)

        result = {
            "name": "Discovery Mix",
            "description": "Smart suggestions expanding your musical horizons.",
            "songs": final,
            "source": "engine",
        }

        cache_recommendation(cache_key, result)
        return result

    # ------------------------------------------------------------------
    # AI Enhancement
    # ------------------------------------------------------------------

    async def enhance_with_ai(
        self,
        candidates: list[dict],
        user_id: str,
        *,
        mood: str = "Chill",
        ai_provider: Any = None,
        limit: int = FINAL_PLAYLIST_SIZE,
    ) -> dict[str, Any]:
        """
        Optional AI enhancement layer.

        Takes the engine's candidate list and asks the AI provider to:
          - Reorder tracks for better flow
          - Generate a playlist name and description
          - Group by mood / energy

        If the AI provider is unavailable or returns an error, the original
        candidates are returned unchanged with ``source = "engine"``.
        """
        if not ai_provider or not ai_provider.configured:
            logger.info("AI provider not configured — skipping AI enhancement.")
            return {
                "name": f"Flow: {mood}",
                "description": self._generate_description(mood, len(candidates), True),
                "songs": candidates[:limit],
                "source": "engine",
            }

        # Build a compact summary of the candidate list for the AI
        songs_summary = [
            {"title": s.get("title", ""), "artist": s.get("artist", "")}
            for s in candidates[:20]
        ]

        prompt = (
            f"You are curating a '{mood}' music playlist. The user wants a '{mood}' vibe — tailor the flow to match this mood.\n"
            f"Here are {len(songs_summary)} candidate songs already selected:\n"
            f"{str(songs_summary)}\n\n"
            "Please reorder them to create a smooth listening flow for the given mood. "
            "Return ONLY a JSON object with these keys:\n"
            "- 'name': a creative playlist name (max 40 chars) that reflects the mood\n"
            "- 'description': a short description (1-2 sentences) describing the vibe\n"
            "- 'songs': the SAME songs list, but reordered as an array of {title, artist} objects\n\n"
            "Do NOT add or remove songs. Do NOT write markdown or notes. Just raw JSON."
        )

        messages = [{"role": "user", "content": prompt}]
        try:
            result = await asyncio.wait_for(
                ai_provider.extract_json(messages, temperature=0.5, timeout=8.0),
                timeout=10.0,
            )
        except asyncio.TimeoutError:
            logger.warning("AI enhancement timed out — using engine candidates.")
            result = None
        except Exception as exc:
            logger.warning(f"AI enhancement failed: {exc}")
            result = None

        if not result or not isinstance(result, dict):
            # AI failed — return engine output
            return {
                "name": f"Flow: {mood}",
                "description": self._generate_description(mood, len(candidates), True),
                "songs": candidates[:limit],
                "source": "engine",
            }

        # Extract reordered songs from AI result
        ai_songs = result.get("songs", [])
        if not ai_songs or not isinstance(ai_songs, list):
            ai_songs = candidates

        # Map AI order back to full candidate objects
        ordered: list[dict] = []
        used_vids: set = set()
        for as_ in ai_songs:
            ai_title = (as_.get("title") or "").lower().strip()
            ai_artist = (as_.get("artist") or "").lower().strip()
            for c in candidates:
                c_vid = c.get("videoId")
                if c_vid and c_vid not in used_vids:
                    c_title = (c.get("title") or "").lower().strip()
                    c_artist = (c.get("artist") or "").lower().strip()
                    if ai_title == c_title and ai_artist == c_artist:
                        ordered.append(c)
                        used_vids.add(c_vid)
                        break

        # Append any candidates the AI omitted
        for c in candidates:
            if c.get("videoId") and c["videoId"] not in used_vids:
                ordered.append(c)
                used_vids.add(c["videoId"])

        return {
            "name": result.get("name", f"Flow: {mood}")[:60],
            "description": result.get("description", self._generate_description(mood, len(ordered), True))[:300],
            "songs": ordered[:limit],
            "source": "ai_enhanced",
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _gather_profile(
        self, database, user_id: str
    ) -> tuple:
        """Fetch user likes, history, stats, top artists, and genres."""
        from bson import ObjectId

        possible_ids = [user_id]
        if ObjectId.is_valid(user_id):
            possible_ids.append(ObjectId(user_id))

        # Likes
        likes_cursor = database[db.LIKED_SONGS].find(
            {"userId": {"$in": possible_ids}},
        ).sort("likedAt", -1).limit(20)
        likes = [l async for l in likes_cursor]

        # History
        history_cursor = database[db.PLAYBACK_HISTORIES].find(
            {"userId": {"$in": possible_ids}},
            {"song": 1, "listenDuration": 1, "playedAt": 1, "_id": 0},
        ).sort("playedAt", -1).limit(50)
        history = [h async for h in history_cursor]

        # User doc for statistics
        user_doc = await database[db.USERS].find_one(
            {"_id": possible_ids[-1]},
        ) if possible_ids else None
        stats = {}
        top_artists = []
        if user_doc:
            stats = user_doc.get("statistics") or {}
            top_artists = self._extract_top_artist_names(stats.get("topArtists") or [])[:5]

        # Compute top genres from history
        top_genres = self._compute_top_genres(history)

        return likes, history, stats, top_artists, top_genres

    @staticmethod
    def _extract_top_artist_names(entries: list) -> list[str]:
        """Pull artist names out of a ``statistics.topArtists`` array.

        The stats writer (see ``routes/user.py``) stores each entry under
        ``"artist"``, plus a ``"display_name"``.  An older reader looked only for
        ``"name"``, found nothing, and produced a list of empty strings — which
        then (a) never matched any real artist, so artist affinity contributed
        nothing to scoring, and (b) fed ``re.escape("")`` into the candidate
        query, i.e. an empty regex that matches EVERY playlist in the database.
        The two bugs together made recommendations look random no matter how
        much the user listened.

        All three keys are accepted so rows written by any version of the stats
        job work, and blanks are dropped rather than propagated.
        """
        names: list[str] = []
        seen: set[str] = set()
        for entry in entries or []:
            if isinstance(entry, str):
                name = entry
            elif isinstance(entry, dict):
                name = entry.get("artist") or entry.get("display_name") or entry.get("name") or ""
            else:
                continue
            name = str(name).strip()
            if not name:
                continue
            key = canonical_artist(name)
            if not key or key in seen:
                continue
            seen.add(key)
            names.append(name)
        return names

    async def _build_candidates(
        self,
        database,
        user_id: str,
        likes: list,
        history: list,
        stats: dict,
        top_artists: list[str],
        top_genres: list[str],
        mood: str,
        exclude: set,
    ) -> list[dict]:
        """Build a diverse candidate pool from multiple sources."""
        candidates: list[dict] = []
        seen_vids: set = set(exclude)

        # --- Source 1: Liked songs (high-quality signal) ---
        for liked in likes:
            song = liked.get("song", {})
            vid = song.get("videoId")
            if vid and vid not in seen_vids:
                seen_vids.add(vid)
                candidates.append(self._to_song_dict(song))

        # --- Source 2: Recently played (familiar tracks) ---
        for h in history[:20]:
            song = h.get("song", {})
            vid = song.get("videoId")
            if vid and vid not in seen_vids:
                seen_vids.add(vid)
                candidates.append(self._to_song_dict(song))

        # --- Source 3: Songs from playlists matching top artists ---
        # Only ever build a regex from a NON-EMPTY name. `re.escape("")` is "",
        # and a `$regex: ""` matches every document in the collection — so one
        # blank artist name silently turned this "find playlists by my favourite
        # artists" query into "sample the entire catalogue at random".
        artist_patterns = [
            {"songs.artist": {"$regex": re.escape(a), "$options": "i"}}
            for a in (n.strip() for n in top_artists[:3])
            if a
        ]
        if artist_patterns:
            playlist_cursor = database[db.PLAYLISTS].aggregate([
                {"$match": {"$or": artist_patterns}},
                {"$unwind": "$songs"},
                {"$sample": {"size": 15}},
                {"$replaceRoot": {"newRoot": "$songs"}},
            ])
            async for song in playlist_cursor:
                vid = song.get("videoId")
                if vid and vid not in seen_vids:
                    seen_vids.add(vid)
                    candidates.append(self._to_song_dict(song))
                    if len(candidates) >= CANDIDATE_POOL_SIZE:
                        break

        # --- Source 4: Random sampling for discovery ---
        if len(candidates) < CANDIDATE_POOL_SIZE:
            needed = CANDIDATE_POOL_SIZE - len(candidates)
            sample_cursor = database[db.PLAYLISTS].aggregate([
                {"$unwind": "$songs"},
                {"$sample": {"size": needed * 2}},
                {"$replaceRoot": {"newRoot": "$songs"}},
            ])
            async for song in sample_cursor:
                vid = song.get("videoId")
                if vid and vid not in seen_vids:
                    seen_vids.add(vid)
                    candidates.append(self._to_song_dict(song))
                    if len(candidates) >= CANDIDATE_POOL_SIZE:
                        break

        # --- Source 5: YTMusic radio for fresh related tracks (always runs) ---
        if likes:
            from app.services.ytmusic import call_ytmusic_safe
            # Pick a random liked song as seed for variety
            seed_liked = random.choice(likes[:10])
            seed_vid = seed_liked.get("song", {}).get("videoId")
            if seed_vid:
                try:
                    watch = await asyncio.to_thread(
                        lambda: call_ytmusic_safe("get_watch_playlist", videoId=seed_vid, limit=15)
                    )
                    if watch and watch.get("tracks"):
                        for track in watch["tracks"]:
                            vid = track.get("videoId")
                            if vid and vid not in seen_vids:
                                seen_vids.add(vid)
                                candidates.append({
                                    "videoId": vid,
                                    "title": track.get("title", "Unknown"),
                                    "artist": ", ".join(
                                        a.get("name", "") for a in (track.get("artists") or [])
                                    ) or "Unknown Artist",
                                    "thumbnail": (
                                        track.get("thumbnail", [{}])[-1].get("url", "")
                                        if track.get("thumbnail")
                                        else f"https://img.youtube.com/vi/{vid}/hqdefault.jpg"
                                    ) if track.get("thumbnail") else f"https://img.youtube.com/vi/{vid}/hqdefault.jpg",
                                    "duration": track.get("length") or 200,
                                })
                except Exception as exc:
                    logger.debug(f"YTMusic radio failed for seed {seed_vid}: {exc}")

        # Fallback static pool if DB is completely empty
        if not candidates:
            candidates = [
                {"videoId": "jfKfPfyJRdk", "title": "Lofi Chill Beats", "artist": "Strumm Curation", "thumbnail": "https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg", "duration": 300},
                {"videoId": "jgpJVIgAmDY", "title": "Nuvole Bianche", "artist": "Ludovico Einaudi", "thumbnail": "https://img.youtube.com/vi/jgpJVIgAmDY/hqdefault.jpg", "duration": 357},
                {"videoId": "5qap5aO4i9A", "title": "Lofi hip hop radio", "artist": "ChilledCow", "thumbnail": "https://img.youtube.com/vi/5qap5aO4i9A/hqdefault.jpg", "duration": 180},
            ]

        return candidates[:CANDIDATE_POOL_SIZE]

    def _score_candidates(
        self,
        candidates: list[dict],
        likes: list,
        history: list,
        top_artists: list[str],
        mood: str,
        discovery_boost: bool = False,
    ) -> list[tuple[dict, float]]:
        """Score each candidate. Higher = better match.

        When ``discovery_boost`` is True (used by the Home page Discovery Mix),
        the boost for known songs is lowered and already-heard tracks are
        *penalised*, because a "Fresh & Undiscovered" mix that leads with
        tracks the user just played through is not discovery at all.
        """
        liked_vids = {l.get("song", {}).get("videoId") for l in likes}

        # --- How much the user actually ENGAGED with each track ---
        # A raw "was played" set treats a track skipped after 4 seconds the same
        # as one played to the end. `listenDuration / duration` separates them,
        # so a genuinely loved track pulls its artist's other songs up the
        # ranking and a flopped one does not.
        heard_seconds: dict[str, float] = {}
        for h in history:
            song = h.get("song") or {}
            vid = song.get("videoId")
            if not vid:
                continue
            heard_seconds[vid] = heard_seconds.get(vid, 0.0) + float(
                h.get("listenDuration") or 0
            )
        history_vids = set(heard_seconds)

        # --- Artist affinity, weighted by how much each artist was played ---
        artist_affinity: dict[str, float] = {}
        for h in history:
            song = h.get("song") or {}
            key = canonical_artist(song.get("artist", ""))
            if not key:
                continue
            duration = float(song.get("duration") or 0) or 1.0
            completion = min(1.0, float(h.get("listenDuration") or 0) / duration)
            artist_affinity[key] = artist_affinity.get(key, 0.0) + completion

        # --- Genre affinity ---
        # The genres were already computed from history and threaded all the way
        # to this function, but nothing ever read them — one of the two signals
        # the module's own architecture diagram promises.
        top_genre_set = {g for g in self._compute_top_genres(history) if g}

        top_artist_keys = {canonical_artist(a) for a in top_artists if canonical_artist(a)}

        mood_keywords = {
            "chill": {"lofi", "chill", "ambient", "calm", "smooth", "slow", "acoustic", "mellow"},
            "energetic": {"remix", "dance", "rock", "hype", "party", "electronic", "bass", "upbeat"},
            "focus": {"lofi", "study", "focus", "instrumental", "ambient", "piano", "jazz", "classical"},
            "sad": {"sad", "melancholy", "alone", "cry", "heartbreak", "slow", "piano", "acoustic"},
            "happy": {"happy", "feel good", "pop", "sunny", "upbeat", "dance", "groove"},
            "romantic": {"love", "romantic", "slow", "ballad", "soul", "rnb", "soft"},
            "workout": {"workout", "gym", "remix", "bass", "rock", "energy", "trap"},
            "party": {"party", "dance", "remix", "club", "electronic", "funk", "reggaeton"},
            "nostalgia": {"classic", "retro", "old", "vintage", "90s", "80s", "memories"},
        }

        keywords = mood_keywords.get(mood.lower(), set())

        # Lower boost multipliers for discovery mode so new songs can surface
        liked_boost = 1.0 if discovery_boost else 3.0
        history_boost = 0.5 if discovery_boost else 1.0
        artist_boost = 1.0 if discovery_boost else 2.0
        genre_boost = 0.6 if discovery_boost else 1.2
        # In discovery mode an already-heard track is subtracted, not added. It
        # used to get `+history_boost`, which meant the more recently you had
        # listened, the higher an already-played track scored.
        heard_penalty = -0.8 if discovery_boost else 0.0
        affinity_cap = 1.5  # keeps one heavily-repeated artist from owning the mix

        max_affinity = max(artist_affinity.values(), default=0.0) or 1.0

        scored = []
        for c in candidates:
            score = 1.0  # base

            vid = c.get("videoId", "")
            title_lower = (c.get("title") or "").lower()
            artist_lower = (c.get("artist") or "").lower()
            artist_canonical = canonical_artist(c.get("artist", ""))

            is_heard = vid in history_vids

            # Boost for liked songs (lowered in discovery mode)
            if vid in liked_vids:
                score += liked_boost

            # Boost if recently played — scaled by how much was actually heard
            duration = float(c.get("duration") or 0) or 1.0
            completion = min(1.0, heard_seconds.get(vid, 0.0) / duration)
            if is_heard:
                score += history_boost * (0.25 + 0.75 * completion)
                if discovery_boost:
                    score += heard_penalty

            # Boost if artist is in top artists
            if artist_canonical and artist_canonical in top_artist_keys:
                score += artist_boost

            # Boost by weighted artist affinity: more listening to that artist
            # means more of their other songs belong in this user's mix.
            #
            # Skipped in discovery mode for a track the user has ALREADY played.
            # The affinity prior exists to surface an artist's *other* songs; for
            # the exact song it was derived from the signal is spent, and letting
            # it fire there let a just-played track outrank an unheard one from
            # the same artist — the opposite of a "Fresh & Undiscovered" mix.
            if artist_canonical and not (discovery_boost and is_heard):
                affinity = artist_affinity.get(artist_canonical, 0.0)
                if affinity:
                    score += min(affinity_cap, artist_boost * affinity / max_affinity)

            # Boost if the track's genre is one the user actually listens to
            if top_genre_set:
                try:
                    genre = classify_genre(c.get("artist", ""), c.get("title", ""))
                except Exception:
                    genre = ""
                if genre in top_genre_set:
                    score += genre_boost

            # Mood/title keyword match
            for kw in keywords:
                if kw in title_lower or kw in artist_lower:
                    score += 0.3

            # Random nudge for variety, so order still fluctuates between cache
            # rotations. Deliberately small: the old +/- 1.0 was as large as the
            # entire artist boost, so the ranking was mostly noise and a
            # personalised mix was indistinguishable from a random one.
            score += random.uniform(-0.15, 0.15)

            scored.append((c, score))

        # Sort by score descending
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored

    def _diversify(self, scored: list[tuple[dict, float]], limit: int) -> list[dict]:
        """
        Select top candidates with multi-dimensional diversity:
          - No more than 2 songs per artist
          - Mix genres (when classifiable)
          - Source variety (liked, played, discovery)
          - Prevent same-artist stacking
        """
        selected: list[dict] = []
        artist_counts: dict[str, int] = {}
        last_artist: str | None = None
        buffer: list[tuple[dict, float]] = list(scored)
        max_per_artist = 2

        while len(selected) < limit and buffer:
            found = False
            for i, (c, s) in enumerate(buffer):
                artist = canonical_artist(c.get("artist", ""))
                artist_count = artist_counts.get(artist, 0)

                # Skip if this artist already has max_per_artist songs
                if artist_count >= max_per_artist:
                    continue

                # Prefer a different artist from the last one for flow
                if artist != last_artist or len(selected) == 0:
                    selected.append(c)
                    last_artist = artist
                    artist_counts[artist] = artist_count + 1
                    buffer.pop(i)
                    found = True
                    break

            if not found:
                # No suitable candidate — take the best remaining that
                # hasn't hit the artist cap
                popped = False
                for i, (c, s) in enumerate(buffer):
                    artist = canonical_artist(c.get("artist", ""))
                    if artist_counts.get(artist, 0) < max_per_artist:
                        selected.append(c)
                        last_artist = artist
                        artist_counts[artist] = artist_counts.get(artist, 0) + 1
                        buffer.pop(i)
                        popped = True
                        break
                if not popped:
                    # All remaining exceed the cap — just take the top
                    best, _ = buffer.pop(0)
                    selected.append(best)
                    last_artist = canonical_artist(best.get("artist", ""))

        return selected[:limit]

    def _compute_top_genres(self, history: list) -> list[str]:
        """Compute the user's top genres from listening history."""
        genre_counts: dict[str, int] = {}
        for h in history:
            song = h.get("song", {})
            title = str(song.get("title", "")).lower()
            artist = str(song.get("artist", "")).lower()
            genre = classify_genre(artist, title)
            genre_counts[genre] = genre_counts.get(genre, 0) + 1

        sorted_genres = sorted(genre_counts.items(), key=lambda x: x[1], reverse=True)
        return [g[0] for g in sorted_genres[:3]] or ["Pop & Indie"]

    def _generate_description(self, mood: str, count: int, has_personalization: bool) -> str:
        """Generate a human-readable playlist description."""
        if has_personalization:
            return (
                f"A personalized {mood.lower()} flow with {count} tracks, "
                f"curated from your listening history and preferences."
            )
        return (
            f"A {mood.lower()} vibe with {count} tracks to set the mood."
        )

    async def _get_recently_recommended(self, database, user_id: str) -> set:
        """Return videoIds recommended to this user in the last 24 hours.

        Sorted newest-first so ``limit(5)`` actually yields the five most recent
        batches. Without the sort Mongo returns them in whatever order the query
        plan produces, so the "freshness" exclusion silently skipped recent
        recommendations and the user kept seeing the same tracks.
        """
        try:
            from bson import ObjectId
            oid = ObjectId(user_id) if ObjectId.is_valid(user_id) else user_id
            cursor = database["recommendation_logs"].find(
                {"userId": str(oid), "createdAt": {"$gt": datetime.utcnow() - timedelta(hours=24)}},
                {"videoIds": 1, "_id": 0},
            ).sort("createdAt", -1).limit(5)
            excluded = set()
            async for doc in cursor:
                for vid in doc.get("videoIds", []):
                    excluded.add(vid)
            return excluded
        except Exception:
            return set()

    async def _record_recommendations(self, database, user_id: str, candidates: list[dict]) -> None:
        """Record which videoIds were recommended for freshness rotation."""
        try:
            from bson import ObjectId
            oid = ObjectId(user_id) if ObjectId.is_valid(user_id) else user_id
            video_ids = [c.get("videoId") for c in candidates if c.get("videoId")]
            if video_ids:
                await database["recommendation_logs"].insert_one({
                    "userId": str(oid),
                    "videoIds": video_ids,
                    "createdAt": datetime.utcnow(),
                })
                # Expire old logs. Match on the same `str(oid)` the insert wrote,
                # otherwise this never matches anything and the log collection
                # grows without bound.
                await database["recommendation_logs"].delete_many({
                    "userId": str(oid),
                    "createdAt": {"$lt": datetime.utcnow() - timedelta(days=3)},
                })
        except Exception:
            pass

    def _to_song_dict(self, song: dict) -> dict:
        """Normalize a song dict to a consistent shape."""
        return {
            "videoId": song.get("videoId", ""),
            "title": song.get("title", "Unknown"),
            "artist": song.get("artist", "Unknown Artist"),
            "thumbnail": song.get("thumbnail", ""),
            "duration": song.get("duration", 180),
        }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_engine: RecommendationEngine = RecommendationEngine()


def get_recommendation_engine() -> RecommendationEngine:
    return _engine
