import csv
from io import StringIO
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Body
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.models.schemas import PlaylistCreateSchema, PlaylistUpdateSchema, SongSchema
from app.services.security import escaped_regex, parse_object_id, sanitize_enum, sanitize_multiline_text, sanitize_text
from app.services.cache import cache_search, get_cached_search
from app.services.normalizer import canonical_song_key
from pydantic import BaseModel
import logging

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
        if not playlist:
            return []
        tracks = playlist.get("tracks", [])
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
    except Exception as e:
        logger.error(f"Error fetching YTMusic playlist: {str(e)}")
        return []


@router.post("/import")
async def import_playlist(
    payload: ImportRequest,
    current_user: dict = Depends(get_current_user)
):
    try:
        from app.routes.search import search_yt_music_songs
        database = db.get_db()
        source = sanitize_enum(payload.source, {"csv", "spotify", "youtube"}, "csv")
        import_name = sanitize_text(payload.name, max_length=120)
        import_data = sanitize_multiline_text(payload.data, max_length=200000)

        parsed_rows = []
        matched = []
        not_found = []
        duplicates = []

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
            parsed_rows = await extract_ytmusic_playlist(import_data)

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

        for track in parsed_rows:
            title = track["title"]
            artist = track.get("artist", "")
            if not title:
                continue

            if "videoId" in track:
                song_item = {
                    "videoId": track["videoId"],
                    "title": track["title"],
                    "artist": track["artist"],
                    "thumbnail": track["thumbnail"],
                    "duration": track["duration"]
                }
                # Rule 1: videoId dedup
                if any(x["videoId"] == song_item["videoId"] for x in matched):
                    duplicates.append(song_item)
                    continue
                # Rule 2: canonical dedup
                incoming_key = canonical_song_key(
                    song_item.get("title", ""),
                    song_item.get("artist", ""),
                )
                if any(
                    canonical_song_key(x.get("title", ""), x.get("artist", "")) == incoming_key
                    for x in matched
                ):
                    duplicates.append(song_item)
                    continue
                matched.append(song_item)
                continue

            regex_title = escaped_regex(title)
            regex_artist = escaped_regex(artist) if artist else None

            query = {"song.title": regex_title}
            if regex_artist:
                query["song.artist"] = regex_artist

            match_doc = await database[db.LIKED_SONGS].find_one(query)
            if not match_doc:
                query = {"songs.title": regex_title}
                if regex_artist:
                    query["songs.artist"] = regex_artist
                match_doc = await database[db.PLAYLISTS].find_one(query, {"songs.$": 1})

            if match_doc:
                song = match_doc["song"] if "song" in match_doc else match_doc["songs"][0]
                song_item = {
                    "videoId": song["videoId"],
                    "title": song["title"],
                    "artist": song["artist"],
                    "thumbnail": song["thumbnail"],
                    "duration": song["duration"]
                }
                # Rule 1: videoId dedup
                if any(x["videoId"] == song_item["videoId"] for x in matched):
                    duplicates.append(song_item)
                    continue
                # Rule 2: canonical dedup
                incoming_key = canonical_song_key(
                    song_item.get("title", ""),
                    song_item.get("artist", ""),
                )
                if any(
                    canonical_song_key(x.get("title", ""), x.get("artist", "")) == incoming_key
                    for x in matched
                ):
                    duplicates.append(song_item)
                    continue
                matched.append(song_item)
            else:
                search_query = f"{title} {artist}".strip()
                search_matches = await search_yt_music_songs(search_query)
                if search_matches:
                    song = search_matches[0]
                    song_item = {
                        "videoId": song["videoId"],
                        "title": song["title"],
                        "artist": song["artist"],
                        "thumbnail": song["thumbnail"],
                        "duration": song["duration"]
                    }
                    # Rule 1: videoId dedup
                    if any(x["videoId"] == song_item["videoId"] for x in matched):
                        duplicates.append(song_item)
                        continue
                    # Rule 2: canonical dedup
                    incoming_key = canonical_song_key(
                        song_item.get("title", ""),
                        song_item.get("artist", ""),
                    )
                    if any(
                        canonical_song_key(x.get("title", ""), x.get("artist", "")) == incoming_key
                        for x in matched
                    ):
                        duplicates.append(song_item)
                        continue
                    matched.append(song_item)
                else:
                    not_found.append({
                        "title": title,
                        "artist": artist,
                        "album": track.get("album", "")
                    })

        if matched:
            new_playlist = {
                "userId": ObjectId(current_user["id"]),
                "name": f"Imported: {import_name}",
                "description": f"Imported from {source} on {datetime.utcnow().strftime('%Y-%m-%d')}",
                "songs": matched,
                "visibility": "private",
                "followers": 0,
                "collaborators": [],
                "createdAt": datetime.utcnow()
            }
            await database[db.PLAYLISTS].insert_one(new_playlist)

        return {
            "success": True,
            "data": {
                "matched": matched,
                "not_found": not_found,
                "duplicates": duplicates,
                "total_matched": len(matched),
                "total_failed": len(not_found)
            }
        }
    except Exception as e:
        logger.error(f"Error importing playlist: {str(e)}")
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
