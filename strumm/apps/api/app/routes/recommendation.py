import os
import json
import random
from fastapi import APIRouter, Depends, Query, Path
from typing import Optional, List, Dict, Any
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import escaped_regex, sanitize_text
import httpx
import logging

logger = logging.getLogger("strumm-recommendation")
router = APIRouter(tags=["recommendation"])

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

async def get_curated_mix_from_groq(mood: str, user_likes: List[dict], user_history: List[dict]) -> List[dict]:
    if not GROQ_API_KEY:
        # Fallback if no GROQ key
        return []
        
    likes_summary = [f"'{s['song']['title']}' by {s['song']['artist']}" for s in user_likes[:10]]
    history_summary = [f"'{s['song']['title']}' by {s['song']['artist']}" for s in user_history[:10]]
    
    mood = sanitize_text(mood, max_length=80)
    prompt = (
        f"The user wants a music recommendation playlist for the mood: '{mood}'. "
        f"Here are some songs the user likes: {', '.join(likes_summary)}. "
        f"Here is their recent listening history: {', '.join(history_summary)}. "
        f"Based on this profile and mood, suggest 6 complementary real song titles and their artists. "
        f"Return ONLY a JSON array of objects, where each object has fields 'title' and 'artist'. "
        f"Do not write any markdown code block wrappers (like ```json), notes, or introductory text. Just raw JSON output."
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "llama-3-8b-8192",
                    "messages": [
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.6
                },
                timeout=12.0
            )
            
            if response.status_code == 200:
                content = response.json()["choices"][0]["message"]["content"].strip()
                if content.startswith("```"):
                    content = content.replace("```json", "").replace("```", "").strip()
                
                suggestions = json.loads(content)
                if isinstance(suggestions, list):
                    return suggestions
    except Exception as e:
        logger.error(f"Error calling Groq for recommendations: {str(e)}")
        
    return []

# Helper: Resolve song recommendation into a mock playback object (or query DB)
async def resolve_suggestions(suggestions: List[dict]) -> List[dict]:
    resolved = []
    database = db.get_db()
    from app.routes.search import search_yt_music_songs
    import asyncio
    
    async def resolve_single(s: dict):
        title = s.get("title", "")
        artist = s.get("artist", "")
        if not title:
            return None
            
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
        
        # If not in DB, search YTMusic
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
            
        # Absolute fallback if YTMusic yields nothing
        str_hash = f"{title}-{artist}".lower()
        mock_id = "dQw4w9WgXcQ"
        if "lofi" in str_hash:
            mock_id = "jfKfPfyJRdk"
        elif "classical" in str_hash:
            mock_id = "jgpJVIgAmDY"
        elif "focus" in str_hash:
            mock_id = "5qap5aO4i9A"
            
        return {
            "videoId": mock_id,
            "title": title,
            "artist": artist,
            "thumbnail": f"https://img.youtube.com/vi/{mock_id}/hqdefault.jpg",
            "duration": 210
        }

    tasks = [resolve_single(s) for s in suggestions]
    results = await asyncio.gather(*tasks)
    return [r for r in results if r is not None]

@router.get("/flow")
async def get_flow(
    mood: str = Query("Chill", description="Mood state: Chill, Focus, Energetic, Sad, Creative"),
    current_user: dict = Depends(get_current_user)
):
    try:
        mood = sanitize_text(mood, max_length=80) or "Chill"
        database = db.get_db()
        userId = current_user["id"]
        
        # Load user history and likes
        likes_cursor = database[db.LIKED_SONGS].find({"userId": userId}).limit(10)
        likes = [l async for l in likes_cursor]
        
        history_cursor = database[db.PLAYBACK_HISTORIES].find({"userId": userId}).sort("playedAt", -1).limit(10)
        history = [h async for h in history_cursor]
        
        # Fetch smart recommendations
        suggestions = await get_curated_mix_from_groq(mood, likes, history)
        
        # Fallback database curation if GROQ fails or isn't set up
        if not suggestions:
            # Sample from user likes or standard songs in DB
            db_songs_cursor = database[db.PLAYLISTS].aggregate([
                {"$unwind": "$songs"},
                {"$sample": {"size": 6}},
                {"$project": {
                    "_id": 0,
                    "videoId": "$songs.videoId",
                    "title": "$songs.title",
                    "artist": "$songs.artist",
                    "thumbnail": "$songs.thumbnail",
                    "duration": "$songs.duration"
                }}
            ])
            resolved = [s async for s in db_songs_cursor]
            
            # If DB is completely empty (no playlists imported yet), load a static catalog
            if not resolved:
                resolved = [
                    {"videoId": "jfKfPfyJRdk", "title": "Lofi Chill Beats", "artist": "Strumm Curation", "thumbnail": "https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg", "duration": 300},
                    {"videoId": "jgpJVIgAmDY", "title": "Nuvole Bianche", "artist": "Ludovico Einaudi", "thumbnail": "https://img.youtube.com/vi/jgpJVIgAmDY/hqdefault.jpg", "duration": 357},
                    {"videoId": "cZUvEPDYcOU", "title": "Heer", "artist": "A.R. Rahman", "thumbnail": "https://img.youtube.com/vi/cZUvEPDYcOU/hqdefault.jpg", "duration": 314}
                ]
        else:
            resolved = await resolve_suggestions(suggestions)
            
        return {
            "success": True,
            "data": {
                "name": f"Flow: {mood}",
                "description": "Your listening flow customized to your mood.",
                "songs": resolved
            }
        }
    except Exception as e:
        logger.error(f"Error resolving Flow curation: {str(e)}")
        return {"success": False, "error": str(e)}

@router.get("/explore-mix")
async def get_discover(
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        userId = current_user["id"]
        
        # Gather profile statistics
        likes_cursor = database[db.LIKED_SONGS].find({"userId": userId}).limit(10)
        likes = [l async for l in likes_cursor]
        
        history_cursor = database[db.PLAYBACK_HISTORIES].find({"userId": userId}).sort("playedAt", -1).limit(10)
        history = [h async for h in history_cursor]
        
        suggestions = await get_curated_mix_from_groq("Fresh & Undiscovered music", likes, history)
        
        if not suggestions:
            # Fallback random curation from general playlists
            db_songs_cursor = database[db.PLAYLISTS].aggregate([
                {"$unwind": "$songs"},
                {"$sample": {"size": 6}},
                {"$project": {
                    "_id": 0,
                    "videoId": "$songs.videoId",
                    "title": "$songs.title",
                    "artist": "$songs.artist",
                    "thumbnail": "$songs.thumbnail",
                    "duration": "$songs.duration"
                }}
            ])
            resolved = [s async for s in db_songs_cursor]
            if not resolved:
                resolved = [
                    {"videoId": "5qap5aO4i9A", "title": "Lofi hip hop radio - beats to relax/study to", "artist": "ChilledCow", "thumbnail": "https://img.youtube.com/vi/5qap5aO4i9A/hqdefault.jpg", "duration": 180},
                    {"videoId": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "artist": "Rick Astley", "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "duration": 212}
                ]
        else:
            resolved = await resolve_suggestions(suggestions)
            
        return {
            "success": True,
            "data": {
                "name": "Discovery Mix",
                "description": "Smart suggestions expanding your musical horizons.",
                "songs": resolved
            }
        }
    except Exception as e:
        logger.error(f"Error creating discovery recommendation: {str(e)}")
        return {"success": False, "error": str(e)}
