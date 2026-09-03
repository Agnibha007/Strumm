import csv
import asyncio
import hashlib
import json
import logging
import random
import traceback
from io import StringIO
from dataclasses import dataclass, field
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import PlaylistCreateSchema, PlaylistUpdateSchema, SongSchema
from app.services.security import escaped_regex, is_valid_youtube_id, parse_object_id, sanitize_enum, sanitize_multiline_text, sanitize_text
from app.services.cache import cache_search, get_cached_search
from app.services.normalizer import (
    canonical_song_key,
    normalize_title_for_match,
    normalize_artist_for_match,
    clean_youtube_title,
    FEAT_RE,
)
from pydantic import BaseModel

logger = logging.getLogger("strumm-playlist")
router = APIRouter(prefix="/playlists", tags=["playlist"])


def is_owner_or_collaborator(playlist: dict, user_id: str) -> bool:
    """Check if user is the owner or a collaborator of the playlist."""
    if str(playlist.get("userId", "")) == user_id:
        return True
    collaborators = playlist.get("collaborators", []) or []
    return user_id in collaborators


# --- Playlist Search (for Playlists filter in search page) ---

@router.get("/search")
async def search_playlists(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(6, ge=1, le=20)
):
    """Search public playlists by name. No auth required."""
    try:
        cleaned_query = sanitize_text(q, max_length=120)
        cache_key_str = f"playlist-search:{cleaned_query}"
        cached = get_cached_search(cache_key_str)
        if cached:
            return {"success": True, "data": cached}

        database = db.get_db()
        regex_query = escaped_regex(cleaned_query)
        cursor = database[db.PLAYLISTS].find(
            {"name": regex_query, "visibility": "public"},
            {"name": 1, "description": 1, "followers": 1, "songs": {"$slice": 1}},
        ).limit(limit)

        playlists = []
        async for p in cursor:
            playlists.append({
                "id": str(p["_id"]),
                "name": p.get("name"),
                "description": p.get("description", ""),
                "followers": p.get("followers", 0),
                "songs": p.get("songs", []),
            })

        cache_search(cache_key_str, playlists)
        return {"success": True, "data": playlists}
    except Exception as e:
        logger.error(f"Playlist search failed: {str(e)}")
        return {"success": True, "data": []}


@router.post("")
async def create_playlist(
    payload: PlaylistCreateSchema,
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        new_playlist = {
            "userId": ObjectId(current_user["id"]),
            "name": payload.name,
            "description": payload.description or "",
            "songs": [],
            "visibility": payload.visibility or "private",
            "followers": 0,
            "collaborators": [],
            "createdAt": datetime.utcnow()
        }

        result = await database[db.PLAYLISTS].insert_one(new_playlist)
        new_playlist["_id"] = str(result.inserted_id)
        new_playlist["id"] = str(result.inserted_id)
        new_playlist["userId"] = str(new_playlist["userId"])

        return {
            "success": True,
            "data": new_playlist
        }
    except Exception as e:
        logger.error(f"Error creating playlist: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


@router.get("")
async def get_playlists(
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        user_id_str = current_user["id"]
        possible_ids = [user_id_str]
        if ObjectId.is_valid(user_id_str):
            possible_ids.append(ObjectId(user_id_str))

        # Find user's playlists (owned OR collaborated)
        cursor = database[db.PLAYLISTS].find({
            "$or": [
                {"userId": {"$in": possible_ids}},
                {"collaborators": user_id_str}
            ]
        })
        playlists = []
        async for doc in cursor:
            doc["_id"] = str(doc["_id"])
            doc["id"] = str(doc["_id"])
            doc["userId"] = str(doc["userId"])

            # Resolve collaborator display names
            collab_ids = doc.get("collaborators", []) or []
            if collab_ids:
                collab_users = await database[db.USERS].find(
                    {"_id": {"$in": [parse_object_id(cid) for cid in collab_ids if ObjectId.is_valid(cid)]}},
                    {"displayName": 1, "username": 1, "avatar": 1}
                ).to_list(length=50)
                doc["collaborators_profiles"] = [
                    {
                        "id": str(u["_id"]),
                        "displayName": u.get("displayName"),
                        "username": u.get("username"),
                        "avatar": u.get("avatar")
                    }
                    for u in collab_users
                ]
            else:
                doc["collaborators_profiles"] = []

            playlists.append(doc)

        return {
            "success": True,
            "data": playlists
        }
    except Exception as e:
        import traceback
        logger.error(f"Error fetching user playlists: {str(e)}\n{traceback.format_exc()}")
        return {"success": False, "error": "An internal error occurred."}


@router.get("/{id}")
async def get_playlist(
    id: str = Path(...),
    current_user: Optional[dict] = Depends(get_current_user),
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        playlist["_id"] = str(playlist["_id"])
        playlist["id"] = playlist["_id"]
        playlist["userId"] = str(playlist["userId"])

        # Check permissions
        user_id = current_user["id"] if current_user else None
        if playlist["visibility"] == "private" and (not user_id or (playlist["userId"] != user_id and not is_owner_or_collaborator(playlist, user_id))):
            return {"success": False, "error": "Access denied to private playlist"}

        # Resolve collaborator display names
        collab_ids = playlist.get("collaborators", []) or []
        if collab_ids:
            collab_users = await database[db.USERS].find(
                {"_id": {"$in": [parse_object_id(cid) for cid in collab_ids if ObjectId.is_valid(cid)]}},
                {"displayName": 1, "username": 1, "avatar": 1}
            ).to_list(length=50)
            playlist["collaborators_profiles"] = [
                {
                    "id": str(u["_id"]),
                    "displayName": u.get("displayName"),
                    "username": u.get("username"),
                    "avatar": u.get("avatar")
                }
                for u in collab_users
            ]
        else:
            playlist["collaborators_profiles"] = []

        return {
            "success": True,
            "data": playlist
        }
    except Exception as e:
        import traceback
        logger.error(f"Error resolving playlist {id}: {str(e)}\n{traceback.format_exc()}")
        return {"success": False, "error": "An internal error occurred."}


@router.patch("/{id}")
async def update_playlist(
    payload: PlaylistUpdateSchema,
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        user_id = current_user["id"]
        is_owner = str(playlist["userId"]) == user_id
        is_collaborator = is_owner_or_collaborator(playlist, user_id)

        if not is_owner and not is_collaborator:
            return {"success": False, "error": "Unauthorized to modify this playlist"}

        update_data = {}

        # Owner can change everything; collaborators can only change songs
        if is_owner:
            if payload.name is not None:
                update_data["name"] = payload.name
            if payload.description is not None:
                update_data["description"] = payload.description
            if payload.visibility is not None:
                update_data["visibility"] = payload.visibility

        if payload.songs is not None:
            update_data["songs"] = [s.model_dump() for s in payload.songs]

        if update_data:
            await database[db.PLAYLISTS].update_one({"_id": parse_object_id(id)}, {"$set": update_data})

        updated_playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        updated_playlist["_id"] = str(updated_playlist["_id"])
        updated_playlist["id"] = updated_playlist["_id"]
        updated_playlist["userId"] = str(updated_playlist["userId"])

        return {
            "success": True,
            "data": updated_playlist
        }
    except Exception as e:
        logger.error(f"Error updating playlist {id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


@router.delete("/{id}")
async def delete_playlist(
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        if str(playlist["userId"]) != current_user["id"]:
            return {"success": False, "error": "Unauthorized to delete this playlist"}

        await database[db.PLAYLISTS].delete_one({"_id": parse_object_id(id)})

        return {
            "success": True,
            "data": {"message": "Playlist deleted successfully"}
        }
    except Exception as e:
        logger.error(f"Error deleting playlist {id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


# --- COLLABORATOR MANAGEMENT ---

class CollaboratorRequest(BaseModel):
    collaboratorId: str
    action: str  # "add" or "remove"


@router.post("/{id}/collaborators")
async def manage_collaborator(
    payload: CollaboratorRequest,
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    """Add or remove a collaborator from a playlist (owner only)."""
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        if str(playlist["userId"]) != current_user["id"]:
            return {"success": False, "error": "Only the playlist owner can manage collaborators"}

        collab_id = payload.collaboratorId
        current_collabs = playlist.get("collaborators", []) or []

        if payload.action == "add":
            # Verify the target user exists
            target_user = await database[db.USERS].find_one({"_id": parse_object_id(collab_id)})
            if not target_user:
                return {"success": False, "error": "User not found"}

            if collab_id not in current_collabs:
                current_collabs.append(collab_id)
            await database[db.PLAYLISTS].update_one(
                {"_id": parse_object_id(id)},
                {"$set": {"collaborators": current_collabs}}
            )

        elif payload.action == "remove":
            if collab_id in current_collabs:
                current_collabs.remove(collab_id)
            await database[db.PLAYLISTS].update_one(
                {"_id": parse_object_id(id)},
                {"$set": {"collaborators": current_collabs}}
            )

        else:
            return {"success": False, "error": "Invalid action. Use 'add' or 'remove'."}

        return {
            "success": True,
            "data": {"collaborators": current_collabs}
        }
    except Exception as e:
        logger.error(f"Error managing collaborator for playlist {id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


# --- PLAYLIST IMPORT ---

class ImportRequest(BaseModel):
    source: str  # spotify, youtube, csv
    name: str
    data: str  # URL or raw CSV string


def parse_spotify_embed_html(html_content: str) -> list:
    import json
    from bs4 import BeautifulSoup
    try:
        soup = BeautifulSoup(html_content, "html.parser")
        next_data = soup.find("script", id="__NEXT_DATA__")
        if not next_data:
            return []

        data = json.loads(next_data.string)

        def find_tracklist(obj):
            if isinstance(obj, dict):
                if "trackList" in obj and isinstance(obj["trackList"], list):
                    return obj["trackList"]
                for k, v in obj.items():
                    res = find_tracklist(v)
                    if res:
                        return res
            elif isinstance(obj, list):
                for item in obj:
                    res = find_tracklist(item)
                    if res:
                        return res
            return None

        tracklist = find_tracklist(data)
        if not tracklist:
            return []

        parsed = []
        for t in tracklist:
            title = t.get("title")
            artists = t.get("subtitle", "")
            artists = artists.replace("\xa0", " ").strip()
            duration_ms = t.get("duration", 0)
            duration_sec = int(duration_ms / 1000) if duration_ms else 200

            parsed.append({
                "title": title,
                "artist": artists,
                "album": "",
                "duration": duration_sec
            })
        return parsed
    except Exception as e:
        logger.error(f"Error parsing spotify embed HTML: {str(e)}")
        return []


async def extract_spotify_playlist(url: str) -> list:
    from app.services.http_client import get_http_client

    playlist_id = None
    entity_type = "playlist"

    if "playlist/" in url:
        playlist_id = url.split("playlist/")[-1].split("?")[0].split("/")[0]
        entity_type = "playlist"
    elif "album/" in url:
        playlist_id = url.split("album/")[-1].split("?")[0].split("/")[0]
        entity_type = "album"
    elif "artist/" in url:
        playlist_id = url.split("artist/")[-1].split("?")[0].split("/")[0]
        entity_type = "artist"
    elif "track/" in url:
        playlist_id = url.split("track/")[-1].split("?")[0].split("/")[0]
        entity_type = "track"

    if not playlist_id:
        return []

    embed_url = f"https://open.spotify.com/embed/{entity_type}/{playlist_id}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    }

    client = get_http_client()

    # 1. Try direct fetch first
    try:
        resp = await client.get(embed_url, headers=headers, timeout=8.0)
        if resp.status_code == 200:
            parsed = parse_spotify_embed_html(resp.text)
            if parsed:
                return parsed
    except Exception as e:
        logger.warning(f"Direct spotify embed fetch failed: {type(e).__name__}")

    # 2. Try alternative fetch methods
    try:
        import random
        proxies_list = ["https://corsproxy.io/?"]
        random.shuffle(proxies_list)

        logger.info("Retrying Spotify scrape with alternative methods...")
        for proxy_url in proxies_list[:3]:
            try:
                proxied_url = f"{proxy_url}{embed_url}"
                resp = await client.get(proxied_url, headers=headers, timeout=8.0, follow_redirects=True)
                if resp.status_code == 200:
                    parsed = parse_spotify_embed_html(resp.text)
                    if parsed:
                        logger.info("Successfully scraped Spotify playlist via proxy")
                        return parsed
            except Exception:
                continue
    except Exception as e:
        logger.error(f"Error fetching spotify via proxies: {type(e).__name__}")

    return []


class YTMusicImportUnavailable(Exception):
    """YouTube Music playlist fetch failed for a transient provider reason.

    Raised so call sites can surface the *true* reason to the user instead of
    collapsing every failure into a misleading 'make sure the playlist is
    public' error. Never raised for a genuinely empty playlist.
    """


async def extract_ytmusic_playlist(url: str) -> list:
    """Extract playlist tracks from YouTube Music URL using ytmusicapi directly."""
    playlist_id = None
    if "list=" in url:
        playlist_id = url.split("list=")[-1].split("&")[0]

    if not playlist_id:
        return []

    try:
        from app.services.ytmusic import call_ytmusic_safe
        import asyncio

        playlist = await asyncio.to_thread(lambda: call_ytmusic_safe("get_playlist", playlist_id, limit=None))
        if playlist is None:
            # The manager reached its resilience ceiling (unreachable / timeout /
            # rate-limit). Surface it; a successful call returns a dict even for
            # an empty playlist.
            raise YTMusicImportUnavailable(
                "Cannot reach YouTube Music right now (unreachable, timed out, or rate-limited). "
                "Wait a few minutes and try again."
            )
        tracks = playlist.get("tracks", [])
        if not tracks:
            # Reachable but genuinely empty (or fully unavailable tracks) — let
            # the caller fall back to line-by-line parsing instead of erroring.
            return []
        parsed = []
        for t in tracks:
            title = t.get("title")
            artists = ", ".join([a.get("name") for a in t.get("artists", []) if a.get("name")])
            album = t.get("album", {}).get("name") if t.get("album") else ""
            video_id = t.get("videoId")
            duration_sec = t.get("duration_seconds") or 200
            thumbnail = t.get("thumbnails", [{}])[-1].get("url") if t.get("thumbnails") else ""

            item = {
                "title": title,
                "artist": artists,
                "album": album,
                "duration": duration_sec
            }
            if video_id:
                item["videoId"] = video_id
            if thumbnail:
                item["thumbnail"] = thumbnail

            parsed.append(item)
        return parsed
    except YTMusicImportUnavailable:
        raise
    except Exception as e:
        logger.error(f"Error fetching YTMusic playlist: {str(e)}")
        raise YTMusicImportUnavailable(
            "YouTube Music playlist fetch failed. Try again in a few minutes."
        )


async def _ytdlp_extract_playlist(url: str) -> list:
    """Extract playlist tracks with yt-dlp (allowed fallback egress).

    Browser-only import policy: this server NEVER egresses to YouTube Music
    (ytmusicapi / youtubei.js) — its egress IP is YouTube-blocked. The browser's
    Piped extractor is the primary path; when it yields nothing, this yt-dlp
    extractor (a different network path) can still recover the concrete tracks.
    Returns ``[]`` on any failure so callers fall through to the line-by-line
    parser / structured error handling.
    """
    try:
        from app.services.ytfallback import ytdlp_playlist

        rows = await asyncio.to_thread(ytdlp_playlist, url)
        parsed = []
        for r in rows:
            item = {
                "title": r.get("title") or "",
                "artist": r.get("artist") or "",
                "album": r.get("album") or "",
                "duration": r.get("duration_seconds") or r.get("duration") or 0,
            }
            if r.get("videoId"):
                item["videoId"] = r["videoId"]
            thumb = (r.get("thumbnails") or [{}])[-1].get("url") if r.get("thumbnails") else ""
            if thumb:
                item["thumbnail"] = thumb
            if item["title"]:
                parsed.append(item)
        return parsed
    except Exception as exc:
        logger.warning(
            f"yt-dlp playlist extract failed for url={url!r}: {type(exc).__name__}: {exc!s:.120}"
        )
        return []


# ---------------------------------------------------------------------------
# Progressive Song Matching Pipeline
# ---------------------------------------------------------------------------

# Confidence thresholds
EXACT_MATCH_CONFIDENCE = 1.0
HIGH_CONFIDENCE_THRESHOLD = 0.92
SIMILAR_MATCH_THRESHOLD = 0.75
FUZZY_MATCH_THRESHOLD = 0.60

# Matcher status taxonomy (see PHASE 7).  Intentionally NOT folded into
# "missing": a search/network failure is transient and must never permanently
# mark a song as unavailable.
STATUS_MATCHED = "matched"
STATUS_NOT_FOUND = "not_found"
STATUS_SEARCH_FAILED = "search_failed"
STATUS_UNREACHABLE = "unreachable"
STATUS_RATE_LIMITED = "rate_limited"
STATUS_TIMEOUT = "timeout"
STATUS_PROVIDER_ERROR = "provider_error"
STATUS_INVALID_METADATA = "invalid_metadata"
STATUS_DUPLICATE = "duplicate"
STATUS_SKIPPED = "skipped"
STATUS_AMBIGUOUS = "ambiguous"

# Per-track search budget: number of distinct fallback queries.
# The bound is guaranteed structurally by _build_query_plan (at most 3 entries:
# title+artist, feat-stripped title, normalized title); no separate runtime cap.
# Max distinct YTMusic HTTP searches per import (hard cap to protect the
# provider from being overwhelmed by very large playlists). Generous enough
# to fully cover a ~100-track playlist (up to 3 planned queries per track)
# without stranding the tail when the fallback chain is resolving real hits.
MAX_SEARCHES_PER_IMPORT = 300
# Bounded concurrent search workers.
IMPORT_CONCURRENCY = 3
# Transient-failure retry budget.
IMPORT_RETRY_ATTEMPTS = 2
IMPORT_RETRY_BASE_DELAY = 0.3  # seconds; + jitter


@dataclass
class ImportContext:
    """Request-scoped state for a single playlist import.

    Holds the dedup/skip sets and the provider-search budget/cache.  A fresh
    context is created per import request, replacing the old module-level
    globals which leaked across concurrent requests.
    """
    source: str = ""
    import_name: str = ""
    # When True, the import must NEVER egress to YouTube Music (ytmusicapi /
    # youtubei.js) from this server: the server's egress IP is YouTube-blocked.
    # Browser-supplied (Piped) candidates are the primary path; when those are
    # absent, yt-dlp (a different egress) is used instead of ytmusicapi.
    # Defaults to False so the provider-agnostic search/match machinery keeps its
    # published contract; the real import flows flip it ON explicitly at the
    # endpoint boundary (see import_playlist / import_playlist_from).
    forbid_ytmusic: bool = False
    # Authenticated user who owns this import. Stage-2 local-library matching
    # is scoped to this id so one user's import can never harvest other users'
    # songs/videoIds from the shared collections.
    user_id: str = ""
    imported_video_ids: set = field(default_factory=set)
    imported_canonical_keys: set = field(default_factory=set)
    searched_queries: set = field(default_factory=set)
    searches_used: int = 0
    # query -> list of raw results (per-import cache avoids duplicate searches)
    search_results_cache: dict = field(default_factory=dict)
    # per-track structured diagnostics for logging / result reporting
    track_logs: list = field(default_factory=list)

    def can_search(self) -> bool:
        return self.searches_used < MAX_SEARCHES_PER_IMPORT


def _get_video_id(item: dict) -> str:
    """Resolve the primary videoId from a search/DB item (handles nesting)."""
    vid = item.get("videoId")
    if vid:
        return vid
    song = item.get("song")
    if isinstance(song, dict):
        return song.get("videoId") or ""
    return ""


def _is_duplicate(ctx: ImportContext, song_item: dict) -> bool:
    """Check if a song is already in the matched list (by videoId or canonical key)."""
    vid = song_item.get("videoId", "")
    if vid and vid in ctx.imported_video_ids:
        return True
    key = canonical_song_key(
        song_item.get("title", ""),
        song_item.get("artist", ""),
    )
    if key in ctx.imported_canonical_keys:
        return True
    return False


def _mark_matched(ctx: ImportContext, song_item: dict):
    """Add a song to the dedup tracking sets."""
    vid = song_item.get("videoId", "")
    if vid:
        ctx.imported_video_ids.add(vid)
    key = canonical_song_key(
        song_item.get("title", ""),
        song_item.get("artist", ""),
    )
    ctx.imported_canonical_keys.add(key)


def _build_song_item(song: dict) -> dict:
    """Build a consistent song item dict from a DB or API result.
    
    Handles both ``artist`` (singular string) and ``artists`` (list of dicts)
    formats. Joins multiple artists with ``, ``.
    """
    artist = song.get("artist", "")
    if not artist:
        raw_artists = song.get("artists") or []
        if raw_artists and isinstance(raw_artists, list):
            parts = []
            for a in raw_artists:
                if isinstance(a, dict):
                    parts.append(a.get("name", ""))
                elif isinstance(a, str):
                    parts.append(a)
            artist = ", ".join(p for p in parts if p)

    # Convert duration from string ("3:45") to seconds if needed
    duration = song.get("duration", 0)
    if isinstance(duration, str) and ":" in duration:
        parts = duration.split(":")
        try:
            if len(parts) == 2:
                duration = int(parts[0]) * 60 + int(parts[1])
            elif len(parts) == 3:
                duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        except (ValueError, IndexError):
            duration = 0

    # Thumbnail: handle both ``thumbnail`` and nested ``thumbnails`` list
    thumbnail = song.get("thumbnail", "")
    if not thumbnail:
        raw_thumbs = song.get("thumbnails") or []
        if raw_thumbs and isinstance(raw_thumbs, list) and len(raw_thumbs) > 0:
            last = raw_thumbs[-1]
            thumbnail = last.get("url", "") if isinstance(last, dict) else ""

    return {
        "videoId": str(song.get("videoId", "") or "").strip(),
        "title": song.get("title", ""),
        "artist": artist,
        "thumbnail": thumbnail,
        "duration": duration or 0,
        "album": song.get("album", "") or "",
    }


VARIANT_QUALIFIERS = {
    "live", "acoustic", "remix", "remaster", "remastered", "cover", "version",
    "deluxe", "edit", "clean", "explicit", "radio", "extended",
    "instrumental", "demo", "unplugged", "orchestral", "piano", "string",
    "karaoke", "sped up", "slowed", "reverb", "studio",
    "mix", "rework", "session", "take", "mono",
}


def _extract_variant_qualifiers(title: str) -> set:
    """
    Extract performance/edition qualifiers from a title that distinguish
    different *versions* of the same track (live/acoustic/remix/remaster/…).

    Used as a symmetric penalty in scoring: a candidate whose variant qualifier
    does not match the source's qualifier is demoted, so the correct recording
    wins over a wrong-but-similarly-titled variant (e.g. 'rockstar' should not
    match 'rockstar (Live)').
    """
    if not title:
        return set()
    norm = normalize_title_for_match(title)
    found = set()
    for q in VARIANT_QUALIFIERS:
        if f" {q}" in f" {norm}" or norm.endswith(f" {q}"):
            found.add(q)
    return found


def _variant_penalty(title_a: str, title_b: str) -> float:
    """
    Symmetric variant-qualifier penalty 0.0..0.12.

    0.0  both sides carry the same qualifier set (or neither does)
    0.08 one side has a qualifier the other lacks (live vs none, live vs studio)
    0.12 both sides carry *different* qualifiers (live vs acoustic);
         only this case *and* the 'vs none' case matter for recall precision.
    """
    qa = _extract_variant_qualifiers(title_a)
    qb = _extract_variant_qualifiers(title_b)
    if qa == qb:
        return 0.0
    if not qa or not qb:
        return 0.08
    return 0.12


def _compute_fuzzy_score(title_a: str, artist_a: str, title_b: str, artist_b: str) -> float:
    """
    Compute a weighted fuzzy similarity score between two song identities.
    Returns a float 0.0 - 1.0.
    """
    from rapidfuzz import fuzz

    t_norm_a = normalize_title_for_match(title_a)
    t_norm_b = normalize_title_for_match(title_b)
    a_norm_a = normalize_artist_for_match(artist_a)
    a_norm_b = normalize_artist_for_match(artist_b)

    # Title similarity: weighted combination of multiple ratio methods
    title_ratio = fuzz.ratio(t_norm_a, t_norm_b) / 100.0
    title_token_sort = fuzz.token_sort_ratio(t_norm_a, t_norm_b) / 100.0
    title_token_set = fuzz.token_set_ratio(t_norm_a, t_norm_b) / 100.0
    title_partial = fuzz.partial_ratio(t_norm_a, t_norm_b) / 100.0

    title_score = (
        title_ratio * 0.35
        + title_token_sort * 0.25
        + title_token_set * 0.25
        + title_partial * 0.15
    )

    # Artist similarity
    artist_ratio = fuzz.ratio(a_norm_a, a_norm_b) / 100.0
    artist_token_set = fuzz.token_set_ratio(a_norm_a, a_norm_b) / 100.0

    if not artist_a or not artist_b:
        artist_score = 1.0  # No artist to compare — don't penalize
    else:
        artist_score = artist_ratio * 0.5 + artist_token_set * 0.5

    # Weighted combined: title (0.6) + artist (0.4)
    combined = title_score * 0.6 + artist_score * 0.4
    # Variant-qualifier penalty (live/remix/acoustic/remaster…): symmetric, so
    # a wrong-version candidate is demoted below the correct recording.
    combined -= _variant_penalty(title_a, title_b)
    return min(max(combined, 0.0), 1.0)


def _duration_similarity(dur_a: int, dur_b: int) -> float:
    """Compute duration similarity as a fraction 0.0 - 1.0."""
    if not dur_a or not dur_b:
        return 1.0  # No duration to compare — neutral
    ratio = min(dur_a, dur_b) / max(dur_a, dur_b)
    return ratio


def _rank_candidates(imported_track: dict, candidates: list) -> list:
    """
    Rank search candidates by combined similarity to the imported track.
    Returns list of (song_item, score) tuples sorted by score descending.

    NOTE: ytmusicapi song search results use ``artists`` (list of dicts) and a
    string ``duration`` ("mm:ss"), so we must extract those into the same
    canonical forms ``_build_song_item`` produces before scoring.  Doing so on
    the raw candidate avoids two real defects: (1) a crash in
    ``_duration_similarity`` when comparing a string duration against an int,
    and (2) ignoring the artist in scoring (empty ``artist`` key caused
    ``_compute_fuzzy_score`` to treat it as "no artist" and not penalise),
    which produced false positives for same-title/different-artist tracks.
    """
    imported_dur = imported_track.get("duration", 0)
    scored = []

    for candidate in candidates:
        # Resolve artist the same way _build_song_item does (artists list or
        # plain artist string).
        cand_artist = candidate.get("artist", "")
        if not cand_artist:
            raw_artists = candidate.get("artists") or []
            if isinstance(raw_artists, list):
                parts = []
                for a in raw_artists:
                    if isinstance(a, dict):
                        parts.append(a.get("name", ""))
                    elif isinstance(a, str):
                        parts.append(a)
                cand_artist = ", ".join(p for p in parts if p)

        # Resolve duration to integer seconds (string "mm:ss" or "h:mm:ss").
        cand_dur = candidate.get("duration", 0)
        cand_dur_secs = candidate.get("duration_seconds")
        if cand_dur_secs:
            cand_dur = cand_dur_secs
        elif isinstance(cand_dur, str) and ":" in cand_dur:
            parts = cand_dur.split(":")
            try:
                if len(parts) == 2:
                    cand_dur = int(parts[0]) * 60 + int(parts[1])
                elif len(parts) == 3:
                    cand_dur = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            except (ValueError, IndexError):
                cand_dur = 0

        title_score = _compute_fuzzy_score(
            imported_track.get("title", ""),
            imported_track.get("artist", ""),
            candidate.get("title", ""),
            cand_artist,
        )
        dur_score = _duration_similarity(imported_dur, cand_dur)
        # Combined: fuzzy text (0.8) + duration (0.2)
        combined = title_score * 0.8 + dur_score * 0.2
        scored.append((_build_song_item(candidate), combined))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored


def _strip_featured(title: str) -> str:
    """Remove a 'feat.'/'ft.'/'featuring' suffix from a title for a fallback
    query, e.g. ''Cold Water (feat. Justin Bieber)'' -> ''Cold Water''."""
    cleaned = clean_youtube_title(title)
    return cleaned.strip() or title.strip()


def _build_query_plan(title: str, artist: str) -> list:
    """
    Build the ordered list of search queries to try for a track.

    Fallback chain (PHASE 6), based on YTMusic's actual search behavior
    (keyword search — no ISRC/provider-ID lookup is exposed by ytmusicapi):
      1. title + artist   (best discriminating query)
      2. title alone with artist stripped of feat/footnote noise
      3. normalized title only
    Each step only runs if the previous one returned too few/no usable
    candidates, so we minimise provider calls while maximising recall.
    """
    t = (title or "").strip()
    a = (artist or "").strip()
    plan = [f"{t} {a}".strip()]

    # Title-without-feat variant (handles 'feat.', 'ft.', 'featuring',
    # bracketed '(...)' remix/version info that can confuse the search).
    stripped = _strip_featured(t)
    if stripped and stripped.lower() != t.lower():
        plan.append(stripped)

    # Title-only variant (handles mis-split/misspelled artist credits).
    norm_t = normalize_title_for_match(t)
    if norm_t and norm_t != normalize_title_for_match(stripped) and norm_t != normalize_title_for_match(t):
        plan.append(norm_t)

    # De-duplicate while preserving order, drop empties.
    seen = set()
    deduped = []
    for q in plan:
        key = q.lower().strip()
        if key and key not in seen:
            seen.add(key)
            deduped.append(q.strip())
    return deduped


def _classify_track_metadata(track: dict) -> Optional[str]:
    """Return an invalid-status reason if the track metadata is unusable, else None."""
    title = (track.get("title") or "").strip()
    if not title:
        return STATUS_INVALID_METADATA
    return None


async def _provider_search(ctx: ImportContext, query: str) -> dict:
    """
    Run one provider search for ``query`` with bounded retry/backoff.

    Returns a dict:
      {"found": bool, "results": list, "status": str, "reason": str}

    A transient failure (unreachable/rate_limited/timeout/provider_error)
    is retried with exponential backoff + jitter (bounded) so a momentary
    provider hiccup does not collapse directly into 'missing'.
    """
    from app.services.ytmusic import search_ytmusic_detailed

    # Per-import query cache: identical tracks / fallbacks share one search.
    cache_key = query.lower().strip()
    if cache_key in ctx.search_results_cache:
        return ctx.search_results_cache[cache_key]

    if not ctx.can_search():
        return {
            "found": False, "results": [],
            "status": STATUS_PROVIDER_ERROR,
            "reason": "per-import search budget exhausted",
        }

    ctx.searches_used += 1
    ctx.searched_queries.add(cache_key)

    retryable = {STATUS_UNREACHABLE, STATUS_RATE_LIMITED, STATUS_TIMEOUT, STATUS_PROVIDER_ERROR}
    for attempt in range(1, IMPORT_RETRY_ATTEMPTS + 1):
        if ctx.forbid_ytmusic:
            # Hard-block: never egress to YouTube Music (ytmusicapi) from this
            # server. The server's IP is YouTube-blocked, so the only browser-
            # safe source of search results is yt-dlp, which uses a different
            # network path. When it finds nothing we report provider_error so
            # the track surfaces as "failed/unresolved" rather than silently
            # falling through to ytmusicapi.
            outcome = await _ytdlp_search_import(query)
        else:
            outcome = await asyncio.to_thread(search_ytmusic_detailed, query, "songs")
        if outcome.found:
            result = {
                "found": True,
                "results": outcome.results[:10],
                "status": STATUS_MATCHED if outcome.results else STATUS_NOT_FOUND,
                "reason": outcome.reason,
            }
            ctx.search_results_cache[cache_key] = result
            return result

        # Map the outcome status to our taxonomy.
        status = {
            "ok": STATUS_NOT_FOUND,
            "unreachable": STATUS_UNREACHABLE,
            "rate_limited": STATUS_RATE_LIMITED,
            "timeout": STATUS_TIMEOUT,
            "error": STATUS_PROVIDER_ERROR,
        }.get(outcome.status, STATUS_PROVIDER_ERROR)

        if attempt < IMPORT_RETRY_ATTEMPTS and status in retryable:
            delay = IMPORT_RETRY_BASE_DELAY * (2 ** (attempt - 1)) + random.uniform(0, 0.15)
            logger.info(
                f"[import] search retry {attempt}/{IMPORT_RETRY_ATTEMPTS} for "
                f"query={cache_key!r} status={status} (delay={delay:.2f}s)"
            )
            await asyncio.sleep(delay)
        else:
            result = {
                "found": False,
                "results": outcome.results or [],
                "status": status,
                "reason": outcome.reason or f"search status={status}",
            }
            ctx.search_results_cache[cache_key] = result
            return result

    # Unreachable in practice.
    result = {
        "found": False, "results": [],
        "status": STATUS_PROVIDER_ERROR, "reason": "search retries exhausted",
    }
    ctx.search_results_cache[cache_key] = result
    return result


class _ImportFallbackOutcome:
    """Duck-typed stand-in for ``YTSearchOutcome`` used by the yt-dlp-only
    (no-ytmusicapi) import search path. Keeps the module free of a hard
    dependency on ytmusic internals while preserving the shared shape."""

    __slots__ = ("found", "status", "reason", "results")

    def __init__(self, found: bool, status: str, reason: str, results: list):
        self.found = found
        self.status = status
        self.reason = reason
        self.results = results or []


async def _ytdlp_search_import(query: str) -> "_ImportFallbackOutcome":
    """
    Browser-only import search: NEVER egresses to YouTube Music from this
    server. Uses ``ytfallback.search_fallback`` (YouTube Data API -> Piped ->
    yt-dlp), which intentionally never touches ytmusicapi/youtubei.js.

    Returns an ``_ImportFallbackOutcome``; a total/transient failure maps to
    status ``unreachable``/``error`` so the caller reports it as failed rather
    than fabricating a ``not_found``.
    """
    from app.services.ytfallback import search_fallback

    try:
        results = await asyncio.to_thread(search_fallback, query)
    except Exception as exc:
        name = type(exc).__name__
        return _ImportFallbackOutcome(
            found=False, status="error",
            reason=f"yt-dlp import search raised: {name}: {exc!s}"[:200],
            results=[],
        )
    if results:
        return _ImportFallbackOutcome(
            found=True, status="ok", reason="yt-dlp import search", results=results
        )
    return _ImportFallbackOutcome(
        found=False, status="unreachable",
        reason="yt-dlp import search returned no results (server egress blocked)",
        results=[],
    )


async def _search_candidates(
    ctx: ImportContext,
    title: str,
    artist: str,
    duration: int = 0,
    injected: Optional[list] = None,
) -> dict:
    """
    Search for song candidates across the ordered fallback query plan.

    ``injected`` (optional): a list of already-fetched, importer-shaped raw
    candidates (e.g. resolved in the user's browser via YouTube Music) for the
    primary query. When non-empty these are preferred and ranked directly —
    the server-side provider chain is skipped (it is only used as a fallback
    when nothing was injected). A None/empty ``injected`` falls through to the
    normal provider search.

    Returns a dict:
      {"candidates": [(song_item, score)], "status": str, "reason": str}
    where status is the originating classification and reason explains why
    matching could not proceed (or that candidates were found).
    """
    if injected:
        # Defense in depth: browser-supplied candidates are UNTRUSTED input.
        # Drop any candidate whose videoId is not a canonical 11-char YouTube
        # id before ranking, so it can never become the matched song. If every
        # injected candidate is invalid, fall through to the provider chain.
        valid_injected = [
            c for c in injected
            if isinstance(c, dict) and is_valid_youtube_id(c.get("videoId"))
        ]
        if valid_injected:
            ranked = _rank_candidates(
                {"title": title, "artist": artist, "duration": duration}, valid_injected
            )
            return {
                "candidates": ranked,
                "status": STATUS_MATCHED,
                "reason": f"found {len(ranked)} browser candidate(s)",
            }
        # All injected candidates were invalid -> behave like not-injected.

    plan = _build_query_plan(title, artist)
    candidates: list = []
    last_status = STATUS_NOT_FOUND
    last_reason = "no candidates found"

    for query in plan:
        if candidates:
            break  # We already have usable candidates; don't add more provider calls.
        outcome = await _provider_search(ctx, query)
        if outcome["found"]:
            candidates.extend(outcome["results"])
        # Record the first meaningful (non-ok) status if we saw one.
        if outcome["status"] != STATUS_NOT_FOUND and last_status == STATUS_NOT_FOUND:
            last_status = outcome["status"]
            last_reason = outcome["reason"]

    if not candidates:
        return {
            "candidates": [],
            "status": last_status,
            "reason": last_reason,
        }

    ranked = _rank_candidates({"title": title, "artist": artist, "duration": duration}, candidates)
    return {
        "candidates": ranked,
        "status": STATUS_MATCHED,
        "reason": f"found {len(ranked)} candidate(s)",
    }


async def _match_track(ctx: ImportContext, track: dict, injected: Optional[list] = None) -> dict:
    """
    Run the progressive matching pipeline for a single imported track.

    ``injected`` (optional): raw candidate items resolved by the browser's
    YouTube Music lookup. Preferred over the server-side provider chain;
    non-empty injected candidates short-circuit the provider search. When no
    candidates were injected the server chain runs as a fallback.

    Returns a dict with keys:
      match, match_type, confidence, candidates (optional),
      status (one of STATUS_*), reason (human-readable diagnostic), logs.

    A transient provider failure results in status ``search_failed``/
    ``rate_limited``/``timeout``/``provider_error`` — NOT ``not_found``.
    """
    title = track.get("title", "")
    artist = track.get("artist", "")

    invalid = _classify_track_metadata(track)
    if invalid:
        return {
            "match": None, "match_type": "none", "confidence": 0.0,
            "status": invalid, "reason": "missing or unusable title/artist",
        }

    # ---- Stage 1: Exact identifier (provider videoId) ----
    # Only a well-formed canonical YouTube video ID may short-circuit to an
    # exact match. Malformed/externally-supplied ids (wrong shape, too short/
    # long, bad chars) must NOT become a matched song — they fall through to
    # Stages 2-3 where a real id can be resolved.
    video_id = track.get("videoId")
    if is_valid_youtube_id(video_id):
        candidate = _build_song_item(track)
        return {
            "match": candidate,
            "match_type": "exact",
            "confidence": EXACT_MATCH_CONFIDENCE,
            "status": STATUS_MATCHED,
            "reason": "matched by provider videoId",
        }

    # ---- Stage 2: canonical-title DB lookup (liked + playlists) ----
    # Scoped to the CURRENT authenticated user: only the user's own liked
    # songs and playlists they own (or are a collaborator on) are consulted.
    # Without the user id no local-library matching runs — a missing id must
    # never fall back to an unscoped global scan.
    database = db.get_db()
    best_match = None
    best_score = 0.0

    user_id_str = ctx.user_id or ""
    if user_id_str:
        possible_ids = [user_id_str]
        if ObjectId.is_valid(user_id_str):
            possible_ids.append(ObjectId(user_id_str))

        # Filter shapes mirror the repository's existing conventions:
        #   likes    -> {"userId": {"$in": [str, ObjectId]}}
        #   playlists-> owner-in OR collaborator-in (== get_playlists).
        scoped_queries = (
            (db.LIKED_SONGS, "song", {"userId": {"$in": possible_ids}}),
            (db.PLAYLISTS, "songs", {
                "$or": [
                    {"userId": {"$in": possible_ids}},
                    {"collaborators": user_id_str},
                ]
            }),
        )

        for coll, path, query in scoped_queries:
            cursor = database[coll].find(query, {path: 1, "_id": 0})
            async for doc in cursor:
                items = doc.get(path) if path == "songs" else [doc.get(path)]
                if not items:
                    continue
                if not isinstance(items, list):
                    items = [items]
                for song in items:
                    if not isinstance(song, dict):
                        continue
                    score = _compute_fuzzy_score(
                        title, artist,
                        song.get("title", ""), song.get("artist", ""),
                    )
                    if score > best_score:
                        best_score = score
                        best_match = song

    if best_match and best_score >= HIGH_CONFIDENCE_THRESHOLD:
        return {
            "match": _build_song_item(best_match),
            "match_type": "similar" if best_score < 1.0 else "exact",
            "confidence": round(best_score, 4),
            "status": STATUS_MATCHED,
            "reason": "matched against local library (high confidence)",
        }

    # ---- Stage 3: provider search (or browser-injected candidates) ----
    search_outcome = await _search_candidates(
        ctx, title, artist, track.get("duration", 0), injected=injected
    )
    candidates_list = None
    search_failed = search_outcome["status"] not in (STATUS_MATCHED, STATUS_NOT_FOUND)

    if search_outcome["candidates"]:
        top_match, top_score = search_outcome["candidates"][0]
        candidates_list = [item for item, _ in search_outcome["candidates"][:5]]

        if top_score >= HIGH_CONFIDENCE_THRESHOLD:
            return {
                "match": top_match,
                "match_type": "similar",
                "confidence": round(top_score, 4),
                "candidates": candidates_list,
                "status": STATUS_MATCHED,
                "reason": f"provider match via {search_outcome['reason']}",
            }
        elif top_score >= SIMILAR_MATCH_THRESHOLD:
            return {
                "match": top_match,
                "match_type": "similar",
                "confidence": round(top_score, 4),
                "candidates": candidates_list,
                "status": STATUS_MATCHED,
                "reason": f"similar provider match via {search_outcome['reason']}",
            }
        elif best_match and best_score >= SIMILAR_MATCH_THRESHOLD:
            return {
                "match": _build_song_item(best_match),
                "match_type": "similar",
                "confidence": round(best_score, 4),
                "candidates": candidates_list,
                "status": STATUS_MATCHED,
                "reason": "local library match below provider threshold",
            }
        # Multiple plausible but low-confidence candidates -> ambiguous.
        if len(search_outcome["candidates"]) >= 2 and top_score >= FUZZY_MATCH_THRESHOLD:
            return {
                "match": None,
                "match_type": "none",
                "confidence": round(top_score, 4),
                "candidates": candidates_list,
                "status": STATUS_AMBIGUOUS,
                "reason": "multiple plausible candidates with low confidence",
            }

    # Transient failure must not masquerade as 'not found'.
    if search_failed:
        return {
            "match": None,
            "match_type": "none",
            "confidence": (round(best_score, 4) if best_match else 0.0),
            "candidates": candidates_list,
            "status": search_outcome["status"],
            "reason": search_outcome["reason"],
        }

    # Genuine: provider returned zero usable candidates and nothing local matched.
    return {
        "match": None,
        "match_type": "none",
        "confidence": round(best_score, 4) if best_match else 0.0,
        "candidates": candidates_list,
        "status": STATUS_NOT_FOUND,
        "reason": "no match found and provider returned no usable candidates",
    }


async def _run_import_pipeline(
    ctx: ImportContext,
    parsed_rows: list,
    user_id: str,
    source: str,
    import_name: str,
    resolve_map: Optional[dict] = None,
) -> dict:
    """
    Run the progressive matching pipeline over ``parsed_rows`` and persist the
    resulting song list as a new private playlist.

    ``resolve_map`` (optional): mapping of track index -> list of raw
    importer-shaped candidates resolved in the user's browser (YouTube Music).
    When present, those candidates are preferred per track; tracks without
    browser candidates fall back to the server-side provider chain.

    Shared by ``POST /import`` (server-side resolution only) and
    ``POST /import/resolve`` (browser-preferred resolution). Returns the same
    ``{"success": True, "data": {...}}`` contract the web app renders.
    """
    database = db.get_db()
    # Scope local-library matching to the importing user.
    ctx.user_id = user_id
    matched = []
    similar_match = []
    not_found = []
    duplicates = []
    skipped = []
    failed = []
    ambiguous = []

    async def process_one(track: dict, injected: Optional[list] = None) -> dict:
        title = track.get("title", "")
        artist = track.get("artist", "")

        # Exact track: ONLY a well-formed canonical YouTube videoId may be
        # persisted as-is. Malformed ids are treated as searchable metadata
        # (they must not become a matched song).
        if is_valid_youtube_id(track.get("videoId")):
            song_item = _build_song_item(track)
            return {"kind": "exact", "song": song_item, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}

        result = await _match_track(ctx, track, injected=injected)

        if result["match"] and result["confidence"] >= HIGH_CONFIDENCE_THRESHOLD:
            return {"kind": "high", "result": result, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}
        if result["match"] and result["confidence"] >= SIMILAR_MATCH_THRESHOLD:
            return {"kind": "similar", "result": result, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}
        if result["status"] == STATUS_AMBIGUOUS:
            return {"kind": "ambiguous", "result": result, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}
        if result["status"] in (STATUS_SEARCH_FAILED, STATUS_UNREACHABLE,
                                STATUS_RATE_LIMITED, STATUS_TIMEOUT, STATUS_PROVIDER_ERROR):
            return {"kind": "failed", "result": result, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}
        if result["status"] == STATUS_INVALID_METADATA:
            return {"kind": "skipped", "result": result, "_track": {
                "title": title, "artist": artist, "album": track.get("album", ""),
            }}
        # Genuine not_found
        return {"kind": "not_found", "result": result, "_track": {
            "title": title, "artist": artist, "album": track.get("album", ""),
        }}

    # Handle exact (videoId) tracks first — no provider search needed.
    exact_tracks = [(i, t) for i, t in enumerate(parsed_rows) if is_valid_youtube_id(t.get("videoId"))]
    searchable = [(i, t) for i, t in enumerate(parsed_rows) if not is_valid_youtube_id(t.get("videoId"))]

    for i, track in exact_tracks:
        out = await process_one(track)
        song_item = out["song"]
        if _is_duplicate(ctx, song_item):
            duplicates.append(song_item)
        else:
            _mark_matched(ctx, song_item)
            matched.append(song_item)

    # Search-bound tracks, processed with bounded concurrency, preserving order.
    results = []
    if searchable:
        semaphore = asyncio.Semaphore(IMPORT_CONCURRENCY)

        async def bounded(indexed_track):
            i, track = indexed_track
            async with semaphore:
                injected = None
                if resolve_map:
                    injected = resolve_map.get(i)
                return await process_one(track, injected)

        results = await asyncio.gather(*(bounded(t) for t in searchable))

    for out in results:
        if out["kind"] == "high":
            m = out["result"]["match"]
            if _is_duplicate(ctx, m):
                duplicates.append(m)
            else:
                _mark_matched(ctx, m)
                if out["result"]["match_type"] == "exact":
                    matched.append(m)
                else:
                    m["match_type"] = out["result"]["match_type"]
                    m["confidence"] = out["result"]["confidence"]
                    similar_match.append(m)
        elif out["kind"] == "similar":
            m = out["result"]["match"]
            if _is_duplicate(ctx, m):
                duplicates.append(m)
            else:
                _mark_matched(ctx, m)
                m["match_type"] = "similar"
                m["confidence"] = out["result"]["confidence"]
                similar_match.append(m)
        elif out["kind"] == "not_found":
            not_found.append({
                "title": out["_track"]["title"],
                "artist": out["_track"]["artist"],
                "album": out["_track"].get("album", ""),
                "status": STATUS_NOT_FOUND,
                "reason": out["result"].get("reason", "no match found"),
                "candidates": out["result"].get("candidates"),
            })
        elif out["kind"] == "ambiguous":
            ambiguous.append({
                "title": out["_track"]["title"],
                "artist": out["_track"]["artist"],
                "album": out["_track"].get("album", ""),
                "status": STATUS_AMBIGUOUS,
                "reason": out["result"].get("reason", "ambiguous match"),
                "confidence": round(out["result"].get("confidence", 0.0), 4),
                "candidates": out["result"].get("candidates"),
            })
        elif out["kind"] == "failed":
            failed.append({
                "title": out["_track"]["title"],
                "artist": out["_track"]["artist"],
                "album": out["_track"].get("album", ""),
                "status": out["result"].get("status", STATUS_SEARCH_FAILED),
                "reason": out["result"].get("reason", "provider search failed"),
                "candidates": out["result"].get("candidates"),
            })
        elif out["kind"] == "skipped":
            skipped.append({
                "title": out["_track"]["title"],
                "artist": out["_track"]["artist"],
                "album": out["_track"].get("album", ""),
                "status": STATUS_INVALID_METADATA,
                "reason": out["result"].get("reason", "unusable metadata"),
            })

    # Structured per-track import log (no secrets / personal data beyond the
    # already-user-supplied track identity, useful for debugging reports).
    for out in results:
        if out["kind"] in ("high", "similar"):
            m = out["result"]["match"]
            ctx.track_logs.append({
                "source_title": out["_track"]["title"],
                "source_artists": out["_track"]["artist"],
                "source_album": out["_track"].get("album", ""),
                "matched_title": m.get("title"),
                "match_method": out["result"].get("match_type", "none"),
                "confidence": round(out["result"].get("confidence", 0.0), 4),
                "final_status": STATUS_MATCHED,
            })
        elif out["kind"] == "not_found":
            ctx.track_logs.append({
                "source_title": out["_track"]["title"],
                "source_artists": out["_track"]["artist"],
                "source_album": out["_track"].get("album", ""),
                "final_status": STATUS_NOT_FOUND,
                "failure_reason": out["result"].get("reason", ""),
            })
        elif out["kind"] in ("failed", "ambiguous"):
            ctx.track_logs.append({
                "source_title": out["_track"]["title"],
                "source_artists": out["_track"]["artist"],
                "source_album": out["_track"].get("album", ""),
                "final_status": out["result"].get("status", "unknown"),
                "failure_reason": out["result"].get("reason", ""),
                "candidate_count": len(out["result"].get("candidates") or []),
            })

    if ctx.track_logs:
        logger.info(
            f"[import] source={ctx.source} name={ctx.import_name!r} "
            f"tracks={len(parsed_rows)} searches_used={ctx.searches_used} "
            f"status={[l.get('final_status') for l in ctx.track_logs]}"
        )
    else:
        logger.info(
            f"[import] source={ctx.source} name={ctx.import_name!r} "
            f"tracks={len(parsed_rows)} (all exact) searches_used=0"
        )

    all_matched = matched + similar_match
    playlist_id = None

    if all_matched:
        new_playlist = {
            "userId": ObjectId(user_id),
            "name": f"Imported: {import_name}",
            "description": f"Imported from {source} on {datetime.utcnow().strftime('%Y-%m-%d')}",
            "songs": all_matched,
            "visibility": "private",
            "followers": 0,
            "collaborators": [],
            "createdAt": datetime.utcnow()
        }
        result = await database[db.PLAYLISTS].insert_one(new_playlist)
        playlist_id = str(result.inserted_id)

    return {
        "success": True,
        "data": {
            "matched": matched,
            "similar_matches": similar_match,
            "not_found": not_found,
            "duplicates": duplicates,
            "ambiguous": ambiguous,
            "failed": failed,
            "skipped": skipped,
            "total_matched": len(matched),
            "total_similar": len(similar_match),
            "total_not_found": len(not_found),
            "total_failed": len(failed),
            "total_ambiguous": len(ambiguous),
            "total_skipped": len(skipped),
            "total_tracks": len(parsed_rows),
            "total_duplicates": len(duplicates),
            "searches_used": ctx.searches_used,
            "playlistId": playlist_id,
        }
    }


@router.post("/import")
async def import_playlist(
    payload: ImportRequest,
    current_user: dict = Depends(get_current_user)
):
    ctx = ImportContext(source=payload.source, forbid_ytmusic=True)
    try:
        database = db.get_db()
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_name = sanitize_text(payload.name, max_length=120)
        import_data = sanitize_multiline_text(payload.data, max_length=200000)
        ctx.source = source
        ctx.import_name = import_name

        parsed_rows = []

        if source == "csv":
            f = StringIO(import_data)
            reader = csv.DictReader(f)

            if not reader.fieldnames or not any(k in [x.lower() for x in reader.fieldnames] for k in ["title", "name", "song"]):
                f.seek(0)
                csv_rows = list(csv.reader(StringIO(import_data)))
                for row in csv_rows:
                    if len(row) >= 2:
                        parsed_rows.append({
                            "title": row[0].strip(),
                            "artist": row[1].strip(),
                            "album": row[2].strip() if len(row) > 2 else ""
                        })
            else:
                for row in reader:
                    normalized_row = {k.lower(): v for k, v in row.items()}
                    title = normalized_row.get("title") or normalized_row.get("name") or normalized_row.get("song", "")
                    artist = normalized_row.get("artist") or normalized_row.get("author") or normalized_row.get("singer", "")
                    album = normalized_row.get("album") or normalized_row.get("record", "")
                    parsed_rows.append({"title": title.strip(), "artist": artist.strip(), "album": album.strip()})

        elif source == "spotify" or "spotify.com" in import_data:
            parsed_rows = await extract_spotify_playlist(import_data)

        elif source == "youtube" or "youtube.com" in import_data or "youtu.be" in import_data:
            # Browser-only policy: the client (Piped) is the primary path. This
            # server never egresses to YouTube Music (ytmusicapi) — its IP is
            # YouTube-blocked. As an allowed fallback, yt-dlp (a different
            # egress) can still fetch a playlist URL when the browser couldn't.
            if any(u in import_data for u in ("youtube.com", "youtu.be")):
                parsed_rows = await _ytdlp_extract_playlist(import_data)
            else:
                parsed_rows = []

        if not parsed_rows and source in ["spotify", "youtube"]:
            for line in import_data.split("\n"):
                line = line.strip()
                if not line or line.startswith("http"):
                    continue
                parts = line.split(" - ")
                if len(parts) >= 2:
                    parsed_rows.append({"title": parts[0].strip(), "artist": parts[1].strip(), "album": ""})
                else:
                    parsed_rows.append({"title": line, "artist": "", "album": ""})

        if not parsed_rows:
            if "spotify.com" in import_data or source == "spotify":
                return {
                    "success": False,
                    "error": "Failed to extract Spotify playlist tracks. Please make sure the playlist is public and try again."
                }
            elif import_data.strip().startswith("http"):
                return {
                    "success": False,
                    "error": "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."
                }
            else:
                return {
                    "success": False,
                    "error": "No tracks found in the provided import data. Check your format and try again."
                }

        # Run the progressive matching pipeline (shared with the browser-
        # assisted /import/resolve endpoint). Server-side resolution only here.
        return await _run_import_pipeline(
            ctx,
            parsed_rows,
            user_id=str(current_user["id"]),
            source=source,
            import_name=import_name,
        )
    except Exception as e:
        logger.error(f"Error importing playlist: {str(e)}\n{traceback.format_exc()}")
        return {"success": False, "error": "An internal error occurred."}


async def _parse_import_rows(source: str, import_data: str) -> dict:
    """Shared parse step for /import, /import/parse and /import/resolve."""
    from io import StringIO as _StringIO
    import csv as _csv

    parsed_rows: list = []

    if source == "csv":
        f = _StringIO(import_data)
        reader = _csv.DictReader(f)
        if not reader.fieldnames or not any(k in [x.lower() for x in reader.fieldnames] for k in ["title", "name", "song"]):
            f.seek(0)
            for row in _csv.reader(_StringIO(import_data)):
                if len(row) >= 2:
                    parsed_rows.append({
                        "title": row[0].strip(),
                        "artist": row[1].strip(),
                        "album": row[2].strip() if len(row) > 2 else ""
                    })
        else:
            for row in reader:
                norm = {k.lower(): v for k, v in row.items()}
                title = norm.get("title") or norm.get("name") or norm.get("song", "")
                artist = norm.get("artist") or norm.get("author") or norm.get("singer", "")
                album = norm.get("album") or norm.get("record", "")
                parsed_rows.append({"title": title.strip(), "artist": artist.strip(), "album": album.strip()})
    elif source == "spotify" or "spotify.com" in import_data:
        parsed_rows = await extract_spotify_playlist(import_data)
    elif source == "youtube" or "youtube.com" in import_data or "youtu.be" in import_data:
        # Browser-only policy: the client (Piped) is the primary path. This
        # server never egresses to YouTube Music (ytmusicapi) — its IP is
        # YouTube-blocked. As an allowed fallback, yt-dlp (a different egress)
        # can still fetch a playlist URL when the browser couldn't.
        if any(u in import_data for u in ("youtube.com", "youtu.be")):
            parsed_rows = await _ytdlp_extract_playlist(import_data)
        else:
            parsed_rows = []

    if not parsed_rows and source in ["spotify", "youtube"]:
        for line in import_data.split("\n"):
            line = line.strip()
            if not line or line.startswith("http"):
                continue
            parts = line.split(" - ")
            if len(parts) >= 2:
                parsed_rows.append({"title": parts[0].strip(), "artist": parts[1].strip(), "album": ""})
            else:
                parsed_rows.append({"title": line, "artist": "", "album": ""})

    return {"parsed_rows": parsed_rows}


class ImportParseResponse(BaseModel):
    success: bool
    tracks: list = []
    error: Optional[str] = None


@router.post("/import/parse")
async def import_parse(
    payload: ImportRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Parse a Spotify / YT Music / CSV import into raw track rows WITHOUT
    resolving them. Returns ``{success, tracks: [{title, artist, album,
    duration}]}`` so the browser can resolve each track's YouTube Music
    candidates client-side before calling ``/import/resolve``.
    """
    try:
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_data = sanitize_multiline_text(payload.data, max_length=200000)
        result = await _parse_import_rows(source, import_data)
        parsed_rows = result["parsed_rows"]

        if not parsed_rows:
            error = (
                "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."
                if "spotify.com" in import_data or import_data.strip().startswith("http")
                else "No tracks found in the provided import data. Check your format and try again."
            )
            return {"success": False, "tracks": [], "error": error}

        return {"success": True, "tracks": parsed_rows}
    except YTMusicImportUnavailable as exc:
        logger.warning("YTMusic parse unavailable for user %s: %s", current_user["id"], exc)
        return {"success": False, "tracks": [], "error": str(exc)}
    except Exception as e:
        logger.error(f"Error parsing playlist: {str(e)}\n{traceback.format_exc()}")
        return {"success": False, "tracks": [], "error": "An internal error occurred."}


class ImportResolveRequest(BaseModel):
    source: str
    name: str
    data: str  # URL or raw CSV string (same contract as ImportRequest)
    candidates: dict = {}  # track index (int key -> str in JSON) -> [raw candidate dicts]
    tracks: list = []
    # Browser-supplied parsed track rows: when present AND non-empty, the
    # server uses them directly instead of re-parsing (and, for youtube source,
    # re-fetching the playlist from YouTube). Each row: {title, artist, album?,
    # duration?, videoId?}.


class ImportResolveResponse(BaseModel):
    success: bool


@router.post("/import/resolve")
async def import_resolve(
    payload: ImportResolveRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Resolve a parsed import using BROWSER-SUPPLIED YouTube Music candidates.

    The browser parses the playlist once (via /import/parse), resolves each
    track's candidates client-side with youtubei.js (YT_MUSIC client on the
    user's residential IP), and POSTs them here keyed by track index.

    For each track: browser candidates (when present) are preferred and ranked
    with the same scoring as server search; tracks without browser candidates
    fall back to the server-side provider chain. Persists the result as a new
    private playlist and returns the same response contract as /import.
    """
    ctx = ImportContext(source=payload.source, forbid_ytmusic=True)
    try:
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_name = sanitize_text(payload.name, max_length=120)
        import_data = sanitize_multiline_text(payload.data, max_length=200000)
        ctx.source = source
        ctx.import_name = import_name

        # Browser-supplied parsed rows take precedence: they let the browser
        # do the YouTube playlist extraction (via Piped) so this endpoint never
        # has to egress to YouTube to re-derive the track list.  When the
        # browser already provided tracks (e.g. YouTube source where Piped
        # extracted the playlist client-side), we skip the server-side parse
        # entirely — it would call ytmusicapi which fails from cloud IPs where
        # YouTube CDN blocks the egress.  Only fall back to the server-side
        # parse when no browser tracks were supplied (CSV, Spotify, or a
        # YouTube import where browser extraction failed and the server must
        # try its own extractor).
        parsed_rows: list = []
        if isinstance(payload.tracks, list) and payload.tracks:
            # Sanitize so malformed/empty rows can't crash downstream matching.
            sanitized_rows: list = []
            for t in payload.tracks:
                if not isinstance(t, dict):
                    continue
                title = (t.get("title") or "").strip()
                if not title:
                    continue
                row: Dict[str, Any] = {"title": title}
                artist = (t.get("artist") or "").strip()
                if artist:
                    row["artist"] = artist
                album = (t.get("album") or "").strip()
                if album:
                    row["album"] = album
                try:
                    duration = int(t.get("duration") or 0)
                    if duration > 0:
                        row["duration"] = duration
                except (TypeError, ValueError):
                    pass
                video_id = (t.get("videoId") or "").strip()
                if video_id:
                    row["videoId"] = video_id
                sanitized_rows.append(row)
            parsed_rows = sanitized_rows

        if not parsed_rows:
            # No browser-supplied rows: parse the URL/data server-side.
            # For YouTube source this calls ytmusicapi which may fail from
            # cloud IP ranges (caught as YTMusicImportUnavailable by the
            # caller).  For CSV/Spotify this is always a local parse.
            result = await _parse_import_rows(source, import_data)
            parsed_rows = result["parsed_rows"]

        if not parsed_rows:
            return {
                "success": False,
                "error": "Failed to extract playlist tracks. Make sure the playlist is public and the URL is correct."
            }

        # Normalize the browser-supplied candidate map. JSON object keys are
        # strings; convert them back to ints and drop malformed entries. Each
        # candidate is passed to the matcher as importer-shaped raw data (the
        # same shape ytmusicapi / fallback providers return).
        resolve_map: Optional[dict] = {}
        for key, raw_candidates in (payload.candidates or {}).items():
            try:
                idx = int(key)
            except (TypeError, ValueError):
                continue
            if isinstance(raw_candidates, list):
                sanitized = []
                for c in raw_candidates:
                    if not isinstance(c, dict):
                        continue
                    vid = c.get("videoId")
                    # Browser candidates are UNTRUSTED: only a well-formed
                    # canonical YouTube video ID survives; the id is stored
                    # stripped of surrounding whitespace.
                    if not is_valid_youtube_id(vid):
                        continue
                    sanitized.append({**c, "videoId": vid.strip()})
                if sanitized:
                    resolve_map[idx] = sanitized

        return await _run_import_pipeline(
            ctx,
            parsed_rows,
            user_id=str(current_user["id"]),
            source=source,
            import_name=import_name,
            resolve_map=resolve_map or None,
        )
    except Exception as e:
        logger.error(f"Error resolving playlist: {str(e)}\n{traceback.format_exc()}")
        return {"success": False, "error": "An internal error occurred."}


class AddSongRequest(BaseModel):
    song: SongSchema


@router.post("/{id}/songs")
async def add_song_to_playlist(
    id: str = Path(..., description="The playlist ID to append the song to"),
    payload: AddSongRequest = Body(...),
    current_user: dict = Depends(get_current_user)
):
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        if not is_owner_or_collaborator(playlist, current_user["id"]):
            return {"success": False, "error": "Unauthorized to modify this playlist"}

        song_dict = payload.song.model_dump()
        songs = playlist.get("songs", [])

        # Rule 1: Reject if videoId already exists
        if any(s.get("videoId") == song_dict.get("videoId") for s in songs):
            return {
                "success": False,
                "error": "Song is already in this playlist."
            }

        # Rule 2: Reject if canonicalTitle + canonicalArtist match an existing song
        incoming_key = canonical_song_key(
            song_dict.get("title", ""),
            song_dict.get("artist", ""),
        )
        if any(
            canonical_song_key(s.get("title", ""), s.get("artist", "")) == incoming_key
            for s in songs
        ):
            return {
                "success": False,
                "error": "This song is already in the playlist (matched by canonical title + artist)."
            }

        await database[db.PLAYLISTS].update_one(
            {"_id": parse_object_id(id)},
            {"$push": {"songs": song_dict}}
        )

        updated_playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        updated_playlist["_id"] = str(updated_playlist["_id"])
        updated_playlist["id"] = updated_playlist["_id"]
        updated_playlist["userId"] = str(updated_playlist["userId"])

        return {
            "success": True,
            "data": updated_playlist
        }
    except Exception as e:
        logger.error(f"Error adding song to playlist {id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}


@router.delete("/{id}/songs/{song_index}")
async def remove_song_from_playlist(
    id: str = Path(...),
    song_index: int = Path(..., description="Index of the song to remove"),
    current_user: dict = Depends(get_current_user)
):
    """Remove a song by its index in the playlist. Allows both owner and collaborators."""
    try:
        database = db.get_db()
        playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})

        if not playlist:
            return {"success": False, "error": "Playlist not found"}

        if not is_owner_or_collaborator(playlist, current_user["id"]):
            return {"success": False, "error": "Unauthorized to modify this playlist"}

        songs = playlist.get("songs", [])
        if song_index < 0 or song_index >= len(songs):
            return {"success": False, "error": "Invalid song index"}

        songs.pop(song_index)
        await database[db.PLAYLISTS].update_one(
            {"_id": parse_object_id(id)},
            {"$set": {"songs": songs}}
        )

        updated_playlist = await database[db.PLAYLISTS].find_one({"_id": parse_object_id(id)})
        updated_playlist["_id"] = str(updated_playlist["_id"])
        updated_playlist["id"] = updated_playlist["_id"]
        updated_playlist["userId"] = str(updated_playlist["userId"])

        return {
            "success": True,
            "data": updated_playlist
        }
    except Exception as e:
        logger.error(f"Error removing song from playlist {id}: {str(e)}")
        return {"success": False, "error": "An internal error occurred."}
