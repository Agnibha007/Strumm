from fastapi import APIRouter, Depends, Query, Path
from typing import Optional, List, Dict, Any
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import escaped_regex, sanitize_text, parse_object_id
from app.services.ai.groq_provider import get_ai_provider
from app.services.recommendation_engine import get_recommendation_engine
import asyncio
import logging

logger = logging.getLogger("strumm-recommendation")
router = APIRouter(tags=["recommendation"])

ai = get_ai_provider()
rec_engine = get_recommendation_engine()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Mood keyword map — used to extract a vibe from the user's free-text prompt
# so the recommendation engine can generate context-aware candidates.
_MOOD_KEYWORDS: dict[str, set[str]] = {
    "Chill": {"chill", "relax", "calm", "lo-fi", "lofi", "mellow", "ambient", "smooth", "peaceful", "sleep", "wind down", "unwind", "take it easy", "de-stress", "laid back", "cozy", "soft", "gentle", "cool down", "downtempo"},
    "Energetic": {"energetic", "hype", "pump", "workout", "work out", "working out", "gym", "exercise", "exercising", "running", "cardio", "active", "motivation", "pump up", "high energy", "intense", "fast", "amped", "turbo", "power", "explosive", "beast", "go hard"},
    "Focus": {"focus", "study", "work", "concentrate", "deep focus", "deep work", "productivity", "reading", "instrumental", "coding", "programming", "homework", "brain", "mental", "clarify"},
    "Happy": {"happy", "good mood", "mood booster", "cheer me up", "uplift", "feel good", "feel better", "joy", "cheerful", "sunny", "positive", "fun", "fun times", "celebrate", "good vibes", "happy", "brighten", "smile", "upbeat", "carefree"},
    "Sad": {"sad", "melancholy", "cry", "emotional", "heartbreak", "breakup", "lonely", "rainy", "down", "blue", "gloomy", "depressed", "depressing", "moody", "somber", "mournful", "moving on", "let go"},
    "Party": {"party", "dance", "club", "celebration", "festival", "party mix", "turn up", "night out", "weekend", "crowd", "banger"},
    "Romantic": {"romantic", "love", "date", "date night", "slow dance", "couple", "valentine", "intimate", "sensual", "cuddle", "crush", "kiss", "passion"},
    "Nostalgia": {"nostalgia", "nostalgic", "retro", "throwback", "old school", "classic", "90s", "80s", "70s", "vintage", "memories", "remember", "childhood", "golden oldies", "blast from the past"},
    "Creative": {"creative", "inspire", "inspiration", "artistic", "imaginative", "dreamy", "experimental", "writing", "brainstorm", "imagination", "inventive", "innovative"},
    "Travel": {"travel", "road trip", "roadtrip", "journey", "wanderlust", "explore", "summer", "vacation", "driving", "cruise", "adventure"},
}


def extract_mood_from_prompt(prompt: str) -> str:
    """
    Extract the most likely mood/vibe from a free-text user prompt.

    Matches keywords in the prompt — case-insensitive — and returns the
    best-matching mood.  Defaults to "Chill" if nothing matches.
    """
    prompt_lower = prompt.lower()
    best_mood = "Chill"
    best_score = 0

    for mood, keywords in _MOOD_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in prompt_lower)
        if score > best_score:
            best_score = score
            best_mood = mood

    return best_mood


async def resolve_suggestions(suggestions: list[dict]) -> list[dict]:
    """Resolve {title, artist} pairs from AI into full song objects.

    Searches the database and YouTube Music to find real songs matching the
    AI's suggestions.  Never returns mock/hardcoded data — if a song can't
    be found it is simply skipped.
    """
    resolved = []
    database = db.get_db()
    from app.routes.search import search_yt_music_songs

    async def resolve_single(s: dict):
        title = s.get("title", "")
        artist = s.get("artist", "")
        if not title:
            return None

        # 1. Try DB match by title
        db_match = await database[db.PLAYLISTS].find_one(
            {"songs.title": escaped_regex(title)},
            {"songs.$": 1}
        )
        if db_match and "songs" in db_match:
            song = db_match["songs"][0]
            return {
                "videoId": song["videoId"],
                "title": song["title"],
                "artist": song["artist"],
                "thumbnail": song["thumbnail"],
                "duration": song["duration"]
            }

        # 2. Search YouTube Music with title + artist
        search_results = await search_yt_music_songs(f"{title} {artist}")
        if search_results:
            best_match = search_results[0]
            return {
                "videoId": best_match["videoId"],
                "title": best_match["title"],
                "artist": best_match["artist"],
                "thumbnail": best_match["thumbnail"],
                "duration": best_match["duration"]
            }

        # 3. Try broader search with just the title
        broader_results = await search_yt_music_songs(title)
        if broader_results:
            best_match = broader_results[0]
            return {
                "videoId": best_match["videoId"],
                "title": best_match["title"],
                "artist": best_match["artist"],
                "thumbnail": best_match["thumbnail"],
                "duration": best_match["duration"]
            }

        # Could not find this song — skip it rather than returning a mock
        return None

    tasks = [resolve_single(s) for s in suggestions]
    results = await asyncio.gather(*tasks)

    seen_vids = set()
    unique_results = []
    for r in results:
        if r is not None:
            vid = r.get("videoId")
            if vid and vid not in seen_vids:
                seen_vids.add(vid)
                unique_results.append(r)
    return unique_results

@router.get("/flow")
async def get_flow(
    mood: str = Query("Chill", description="Mood state: Chill, Focus, Energetic, Sad, Creative"),
    current_user: dict = Depends(get_current_user),
):
    """
    Generate a personalized Flow playlist.

    1. Uses the shared RecommendationEngine to produce candidates from
       the user's listening history, likes, top artists, and genres.
    2. Optionally enhances with AI (reorder, name, description).
    3. Falls back gracefully to engine output if AI is unavailable.
    """
    try:
        mood = sanitize_text(mood, max_length=80) or "Chill"
        user_id = current_user["id"]

        # Step 1: Engine-generated candidates (always works)
        engine_result = await rec_engine.generate(
            user_id, mood=mood, limit=20,
        )

        # Step 2: AI enhancement (optional — errors are swallowed)
        enhanced = await rec_engine.enhance_with_ai(
            engine_result["songs"],
            user_id,
            mood=mood,
            ai_provider=ai,
            limit=15,
        )

        return {
            "success": True,
            "data": enhanced,
        }
    except Exception as e:
        logger.error(f"Error resolving Flow curation: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}

@router.get("/explore-mix")
async def get_discover(
    current_user: dict = Depends(get_current_user),
):
    """Generate a Discovery Mix for the Home page using the shared engine."""
    try:
        user_id = current_user["id"]
        result = await rec_engine.generate_discovery(user_id)
        return {
            "success": True,
            "data": result,
        }
    except Exception as e:
        logger.error(f"Error creating discovery recommendation: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}

# --- RADIO MODE ---

@router.get("/radio/{video_id}")
async def get_radio(
    video_id: str = Path(..., description="Seed videoId to generate radio from"),
    limit: int = Query(20, ge=5, le=50, description="Number of radio tracks to return"),
    current_user: Optional[dict] = Depends(get_current_user),
):
    """Generate an infinite radio stream based on a seed song.
    Uses the active music provider to fetch related tracks.
    """
    try:
        from app.services.ytmusic import call_ytmusic_safe

        watch = await asyncio.to_thread(lambda: call_ytmusic_safe(
            "get_watch_playlist",
            videoId=video_id,
            limit=limit
        ))

        if not watch or not watch.get("tracks"):
            return {"success": False, "error": "No related tracks found for this song."}

        tracks = watch["tracks"]
        radio_songs = []
        for track in tracks:
            vid = track.get("videoId")
            if not vid or vid == video_id:
                continue

            title = track.get("title", "Unknown")
            artists_list = track.get("artists", [])
            artist = ", ".join(
                [a.get("name", "") for a in artists_list if a.get("name")]
            ) if artists_list else "Unknown Artist"
            duration = track.get("length") or 200
            thumbnails = track.get("thumbnail", [])
            thumbnail = thumbnails[-1].get("url", "") if thumbnails else (
                f"https://img.youtube.com/vi/{vid}/hqdefault.jpg"
            )

            radio_songs.append({
                "videoId": vid,
                "title": title,
                "artist": artist,
                "thumbnail": thumbnail,
                "duration": duration
            })

        if not radio_songs:
            return {"success": False, "error": "No related tracks found."}

        return {
            "success": True,
            "data": {
                "seed": video_id,
                "songs": radio_songs,
                "total": len(radio_songs),
                "radio_session": f"radio_{video_id}"
            }
        }
    except Exception as e:
        logger.error(f"Error generating radio for {video_id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


from pydantic import BaseModel

class ChatMessageSchema(BaseModel):
    role: str  # 'user' or 'assistant'
    content: str

class ChatRequest(BaseModel):
    prompt: str
    history: Optional[List[ChatMessageSchema]] = []
    confirm_edit: Optional[bool] = False
    playlist_id: Optional[str] = None
    songs_to_add: Optional[List[dict]] = []
    songs_to_remove: Optional[List[dict]] = []

@router.post("/explore-chat")
async def explore_chat(
    payload: ChatRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        from datetime import datetime
        database = db.get_db()
        userId = current_user["id"]
        
        # Check if confirming an edit action directly
        if payload.confirm_edit:
            playlist_id = payload.playlist_id
            if not playlist_id:
                return {"success": False, "error": "Playlist ID is required for editing."}
                
            playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(playlist_id)})
            if not playlist:
                return {"success": False, "error": "Playlist not found."}
                
            if playlist.get("userId") != userId:
                return {"success": False, "error": "Unauthorized to edit this playlist."}
                
            updated_songs = list(playlist.get("songs", []))
            
            # Resolve songs to add
            if payload.songs_to_add:
                resolved_add = await resolve_suggestions(payload.songs_to_add)
                # Avoid adding duplicates (by videoId)
                existing_vids = {s.get("videoId") for s in updated_songs if s.get("videoId")}
                for rs in resolved_add:
                    if rs.get("videoId") not in existing_vids:
                        updated_songs.append(rs)
                        
            # Resolve songs to remove
            if payload.songs_to_remove:
                # Find matching songs in updated_songs by title / artist or videoId
                remove_titles = {s["title"].lower().strip() for s in payload.songs_to_remove}
                remove_artists = {s["artist"].lower().strip() for s in payload.songs_to_remove}
                
                new_songs = []
                for s in updated_songs:
                    title_match = s.get("title", "").lower().strip() in remove_titles
                    artist_match = s.get("artist", "").lower().strip() in remove_artists
                    if title_match and artist_match:
                        continue
                    new_songs.append(s)
                updated_songs = new_songs
                
            await database[db.PLAYLISTS].update_one(
                {"_id": parse_object_id(playlist_id)},
                {"$set": {"songs": updated_songs}}
            )
            
            return {
                "success": True,
                "data": {
                    "message": f"Playlist '{playlist.get('name')}' updated successfully!",
                    "songs": [],
                    "playlist": {
                        "id": playlist_id,
                        "name": playlist.get("name"),
                        "songs_count": len(updated_songs)
                    }
                }
            }

        user_prompt = sanitize_text(payload.prompt, max_length=1000)
        
        # 1. Fetch user data (same data sources as recommendation engine)
        likes_cursor = database[db.LIKED_SONGS].find({"userId": userId}).limit(15)
        likes = [l async for l in likes_cursor]
        likes_summary = ", ".join([f"'{s['song']['title']}' by {s['song']['artist']}" for s in likes])
        
        history_cursor = database[db.PLAYBACK_HISTORIES].find({"userId": userId}).sort("playedAt", -1).limit(15)
        history = [h async for h in history_cursor]
        history_summary = ", ".join([f"'{s['song']['title']}' by {s['song']['artist']}" for s in history])
        
        playlists_cursor = database[db.PLAYLISTS].find({"userId": userId})
        playlists = [p async for p in playlists_cursor]
        playlist_summary = ", ".join([f"'{p['name']}' (ID: {str(p['_id'])})" for p in playlists])
        
        # 2. Extract mood from user prompt and generate context-aware engine candidates
        prompt_mood = extract_mood_from_prompt(user_prompt)
        logger.debug(f"Extracted mood '{prompt_mood}' from prompt: {user_prompt[:80]}")
        engine_candidates = await rec_engine.generate(
            user_id=userId,
            mood=prompt_mood,
            limit=10,
            exclude_video_ids=set(),
        )
        engine_songs_summary = ", ".join(
            [f"'{s['title']}' by {s['artist']}" for s in engine_candidates.get("songs", [])[:6]]
        )
        
        if not likes_summary:
            likes_summary = "None (New user)"
        if not history_summary:
            history_summary = "None (New user)"
        if not playlist_summary:
            playlist_summary = "None (No playlists created yet)"
        if not engine_songs_summary:
            engine_songs_summary = "(Will be generated from scratch)"
            
        system_prompt = (
            "You are 'Strumm Flow', a premium, intelligent music curator assistant. Your goal is to help the user discover music, answer music-related questions, suggest tracks, build custom playlists, or edit existing playlists.\n"
            f"The user is looking for a '{prompt_mood}' vibe. Tailor your suggestions to match this mood.\n"
            "You are provided with details about the user's music taste:\n"
            f"1. Liked songs: {likes_summary}\n"
            f"2. Listening history: {history_summary}\n"
            f"3. User's existing playlists with their database IDs: {playlist_summary}\n"
            f"4. Pre-generated recommendation candidates (for reference/selection): {engine_songs_summary}\n\n"
            "Your response MUST be a valid JSON object containing exactly the following keys:\n"
            "- 'message': (string) Your text response to the user's message. Be conversational, polite, and explain your recommendations or actions. Keep it brief (2-4 sentences).\n"
            "- 'songs': (array of objects) If recommending songs, include up to 6 recommended songs. You may select from the pre-generated candidates above OR suggest new ones. Each object must have keys 'title' and 'artist'. Otherwise, return an empty array [].\n"
            "- 'create_playlist': (boolean) Set to true ONLY if the user explicitly asked to create, save, build, or make a playlist. Otherwise, set to false.\n"
            "- 'playlist_name': (string) If create_playlist is true, specify a creative name for the playlist. Otherwise, null.\n"
            "- 'playlist_description': (string) If create_playlist is true, specify a short description. Otherwise, null.\n"
            "- 'edit_playlist': (boolean) Set to true ONLY if the user explicitly asked to edit, modify, add tracks to, or remove tracks from an existing playlist. Otherwise, set to false.\n"
            "- 'playlist_id': (string) If edit_playlist is true, specify the exact ID of the playlist to be edited (from the provided list of existing playlists). Otherwise, null.\n"
            "- 'songs_to_add': (array of objects) If editing a playlist, list the songs to be added. Each object must have keys 'title' and 'artist'. Otherwise, an empty array [].\n"
            "- 'songs_to_remove': (array of objects) If editing a playlist, list the songs to be removed. Each object must have keys 'title' and 'artist'. Otherwise, an empty array [].\n"
            "- 'requires_confirmation': (boolean) Set to true if the user wants to edit/overwrite pre-made content. Otherwise, set to false.\n\n"
            "Rules:\n"
            "1. Suggest ONLY real, existing songs and artists.\n"
            "2. You may pick from the pre-generated candidates or suggest different ones — use your best judgment.\n"
            "3. Return ONLY the JSON object. Do not include markdown code block wrappers, introductory text, or concluding notes. Just raw JSON."
        )
        
        if not ai.configured:
            # AI not available — return engine candidates directly
            return {
                "success": True,
                "data": {
                    "message": "Here's a personalized flow based on your listening preferences:",
                    "songs": engine_candidates.get("songs", []),
                    "playlist": None,
                    "source": "engine",
                }
            }

        messages_payload = [{"role": "system", "content": system_prompt}]
        for hist_msg in payload.history or []:
            messages_payload.append({"role": hist_msg.role, "content": hist_msg.content})
        messages_payload.append({"role": "user", "content": user_prompt})

        result_data = await ai.extract_json(messages_payload, temperature=0.7, timeout=10.0)
        if result_data is None:
            # AI failed — return engine candidates as fallback
            return {
                "success": True,
                "data": {
                    "message": "Here's a personalized flow based on your listening preferences:",
                    "songs": engine_candidates.get("songs", []),
                    "playlist": None,
                    "source": "engine",
                }
            }

        message = result_data.get("message", "Here is your update:")
        songs_suggestions = result_data.get("songs", [])
        create_playlist = result_data.get("create_playlist", False)
        playlist_name = result_data.get("playlist_name", "Flow Curated Playlist")
        playlist_description = result_data.get("playlist_description", "Generated dynamically by Strumm Flow.")
        
        edit_playlist = result_data.get("edit_playlist", False)
        playlist_id = result_data.get("playlist_id", None)
        songs_to_add = result_data.get("songs_to_add", [])
        songs_to_remove = result_data.get("songs_to_remove", [])
        requires_confirmation = result_data.get("requires_confirmation", False)

        resolved_songs = []
        if songs_suggestions:
            resolved_songs = await resolve_suggestions(songs_suggestions)
        # If AI didn't suggest songs, use engine candidates
        if not resolved_songs:
            resolved_songs = engine_candidates.get("songs", [])
            
        created_playlist_info = None
        if create_playlist and resolved_songs:
            new_playlist = {
                "userId": userId,
                "name": playlist_name,
                "description": playlist_description,
                "songs": resolved_songs,
                "visibility": "private",
                "followers": 0,
                "createdAt": datetime.utcnow()
            }
            res = await database[db.PLAYLISTS].insert_one(new_playlist)
            created_playlist_info = {
                "id": str(res.inserted_id),
                "name": playlist_name,
                "songs_count": len(resolved_songs)
            }
            
        return {
            "success": True,
            "data": {
                "message": message,
                "songs": resolved_songs,
                "playlist": created_playlist_info,
                "edit_playlist": edit_playlist,
                "playlist_id": playlist_id,
                "songs_to_add": songs_to_add,
                "songs_to_remove": songs_to_remove,
                "requires_confirmation": requires_confirmation
            }
        }
    except Exception as e:
        logger.error(f"Error in explore chat interaction: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}