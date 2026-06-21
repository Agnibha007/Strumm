import os
import json
from datetime import datetime
from bson import ObjectId
from app.database import mongodb as db

# Duration parser: converts "MM:SS" or "HH:MM:SS" to integer seconds
def parse_duration(duration_str) -> int:
    if duration_str is None:
        return 180  # Default 3 mins if missing
    if isinstance(duration_str, (int, float)):
        return int(duration_str)
    duration_str = str(duration_str).strip()
    if ":" in duration_str:
        parts = duration_str.split(":")
        try:
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(parts[1])
            elif len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        except ValueError:
            pass
    try:
        return int(float(duration_str))
    except ValueError:
        return 180

# Convert old Yuzone themes to Strumm themes
def convert_theme(old_theme: str) -> str:
    if not old_theme:
        return "Obsidian"
    old_theme = str(old_theme).lower()
    if "cherry" in old_theme or "purple" in old_theme or "pink" in old_theme:
        return "Black Cherry"
    elif "vinyl" in old_theme or "classic" in old_theme or "retro" in old_theme or "brown" in old_theme:
        return "Vinyl Classic"
    elif "ocean" in old_theme or "drive" in old_theme or "blue" in old_theme:
        return "Ocean Drive"
    elif "monochrome" in old_theme or "black" in old_theme or "white" in old_theme:
        return "Monochrome"
    elif "aurora" in old_theme or "green" in old_theme or "mint" in old_theme:
        return "Aurora"
    else:
        return "Obsidian"

# Helper to load MongoDB-extended JSON exports safely
def load_json_file(file_path: str):
    if not os.path.exists(file_path):
        print(f"Migration: File not found {file_path}")
        return None
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)

# MongoDB BSON helper parsing
def parse_bson_date(date_val):
    if not date_val:
        return datetime.utcnow()
    if isinstance(date_val, dict) and "$date" in date_val:
        date_str = date_val["$date"]
        # Strip trailing Z/milliseconds if necessary
        try:
            if date_str.endswith("Z"):
                date_str = date_str[:-1]
            if "." in date_str:
                date_str = date_str.split(".")[0]
            return datetime.fromisoformat(date_str)
        except Exception:
            return datetime.utcnow()
    return datetime.utcnow()

def parse_bson_id(id_val):
    if not id_val:
        return str(ObjectId())
    if isinstance(id_val, dict) and "$oid" in id_val:
        return id_val["$oid"]
    return str(id_val)

async def run_yuzone_migration(json_dir: str) -> dict:
    results = {}
    database = db.get_db()

    # 1. Migrate Users
    users_data = load_json_file(os.path.join(json_dir, "yuzone-music.users.json"))
    if users_data:
        migrated_users = []
        for u in users_data:
            user_id = parse_bson_id(u.get("_id"))
            email = u.get("email", f"user_{user_id}@strumm.music")
            name = u.get("name", "Strummer")
            theme = convert_theme(u.get("theme"))
            
            user_doc = {
                "_id": ObjectId(user_id),
                "email": email,
                "username": email.split("@")[0],
                "displayName": name,
                "avatar": u.get("image"),
                "providers": u.get("providers", ["google"]),
                "theme": theme,
                "createdAt": parse_bson_date(u.get("createdAt")),
                "settings": {
                    "audioQuality": "high",
                    "animations": True,
                    "privacy": "public",
                    "theme": theme
                },
                "statistics": {
                    "totalListeningTime": 0,
                    "monthlyListeningTime": 0,
                    "topSongs": [],
                    "topArtists": []
                }
            }
            migrated_users.append(user_doc)
        
        if migrated_users:
            await database[db.USERS].delete_many({})
            await database[db.USERS].insert_many(migrated_users)
            results["users"] = len(migrated_users)

    # 2. Migrate Playlists
    playlists_data = load_json_file(os.path.join(json_dir, "yuzone-music.playlists.json"))
    if playlists_data:
        migrated_playlists = []
        for p in playlists_data:
            playlist_id = parse_bson_id(p.get("_id"))
            userId = parse_bson_id(p.get("userId"))
            
            # Map songs array
            songs_list = []
            for s in p.get("songs", []):
                songs_list.append({
                    "videoId": s.get("videoId", ""),
                    "title": s.get("title", "Untitled Track"),
                    "artist": s.get("artist", "Unknown Artist"),
                    "thumbnail": s.get("thumbnail", ""),
                    "duration": parse_duration(s.get("duration")),
                    "metadata": {}
                })

            playlist_doc = {
                "_id": ObjectId(playlist_id),
                "userId": userId,
                "name": p.get("name", "New Playlist"),
                "description": p.get("description", ""),
                "songs": songs_list,
                "visibility": p.get("visibility", "private"),
                "followers": p.get("followers", 0),
                "createdAt": parse_bson_date(p.get("createdAt"))
            }
            migrated_playlists.append(playlist_doc)
        
        if migrated_playlists:
            await database[db.PLAYLISTS].delete_many({})
            await database[db.PLAYLISTS].insert_many(migrated_playlists)
            results["playlists"] = len(migrated_playlists)

    # 3. Migrate Liked Songs
    likes_data = load_json_file(os.path.join(json_dir, "yuzone-music.likedsongs.json"))
    if likes_data:
        migrated_likes = []
        for l in likes_data:
            like_id = parse_bson_id(l.get("_id"))
            userId = parse_bson_id(l.get("userId"))
            
            like_doc = {
                "_id": ObjectId(like_id),
                "userId": userId,
                "song": {
                    "videoId": l.get("videoId", ""),
                    "title": l.get("title", "Untitled Track"),
                    "artist": l.get("artist", "Unknown Artist"),
                    "thumbnail": l.get("thumbnail", ""),
                    "duration": parse_duration(l.get("duration")),
                    "metadata": {}
                },
                "likedAt": parse_bson_date(l.get("likedAt") or l.get("createdAt"))
            }
            migrated_likes.append(like_doc)
            
        if migrated_likes:
            await database[db.LIKED_SONGS].delete_many({})
            await database[db.LIKED_SONGS].insert_many(migrated_likes)
            results["liked_songs"] = len(migrated_likes)

    # 4. Migrate Playback History
    histories_data = load_json_file(os.path.join(json_dir, "yuzone-music.playbackhistories.json"))
    if histories_data:
        migrated_history = []
        for h in histories_data:
            hist_id = parse_bson_id(h.get("_id"))
            userId = parse_bson_id(h.get("userId"))
            
            hist_doc = {
                "_id": ObjectId(hist_id),
                "userId": userId,
                "song": {
                    "videoId": h.get("videoId", ""),
                    "title": h.get("title", "Untitled Track"),
                    "artist": h.get("artist", "Unknown Artist"),
                    "thumbnail": h.get("thumbnail", ""),
                    "duration": parse_duration(h.get("duration")),
                    "metadata": {}
                },
                "listenDuration": int(h.get("listenDuration", 30)),
                "playedAt": parse_bson_date(h.get("playedAt") or h.get("createdAt"))
            }
            migrated_history.append(hist_doc)
            
        if migrated_history:
            # Batch size insertion in case history log is massive
            await database[db.PLAYBACK_HISTORIES].delete_many({})
            batch_size = 5000
            for idx in range(0, len(migrated_history), batch_size):
                batch = migrated_history[idx:idx+batch_size]
                await database[db.PLAYBACK_HISTORIES].insert_many(batch)
            results["playback_histories"] = len(migrated_history)

    # 5. Migrate Podcast Shows & Episodes
    shows_data = load_json_file(os.path.join(json_dir, "yuzone-music.podcastshows.json"))
    if shows_data:
        migrated_shows = []
        for s in shows_data:
            show_id = parse_bson_id(s.get("_id"))
            show_doc = {
                "_id": ObjectId(show_id),
                "title": s.get("title", "Untitled Podcast"),
                "author": s.get("author", "Unknown Host"),
                "description": s.get("description", ""),
                "image": s.get("image", ""),
                "rss": s.get("rss", ""),
                "categories": s.get("categories", [])
            }
            migrated_shows.append(show_doc)
        
        if migrated_shows:
            await database[db.PODCAST_SHOWS].delete_many({})
            await database[db.PODCAST_SHOWS].insert_many(migrated_shows)
            results["podcast_shows"] = len(migrated_shows)

    episodes_data = load_json_file(os.path.join(json_dir, "yuzone-music.podcastepisodes.json"))
    if episodes_data:
        migrated_episodes = []
        for ep in episodes_data:
            ep_id = parse_bson_id(ep.get("_id"))
            show_id = parse_bson_id(ep.get("showId"))
            ep_doc = {
                "_id": ObjectId(ep_id),
                "showId": show_id,
                "title": ep.get("title", "Untitled Episode"),
                "audioUrl": ep.get("audioUrl", ""),
                "duration": parse_duration(ep.get("duration")),
                "description": ep.get("description", ""),
                "publishedAt": parse_bson_date(ep.get("publishedAt") or ep.get("createdAt"))
            }
            migrated_episodes.append(ep_doc)
            
        if migrated_episodes:
            await database[db.PODCAST_EPISODES].delete_many({})
            # Batch insert episodes
            batch_size = 5000
            for idx in range(0, len(migrated_episodes), batch_size):
                batch = migrated_episodes[idx:idx+batch_size]
                await database[db.PODCAST_EPISODES].insert_many(batch)
            results["podcast_episodes"] = len(migrated_episodes)

    # 6. Migrate Player States
    player_data = load_json_file(os.path.join(json_dir, "yuzone-music.playerstates.json"))
    if player_data:
        migrated_player_states = []
        for ps in player_data:
            ps_id = parse_bson_id(ps.get("_id"))
            userId = parse_bson_id(ps.get("userId"))
            
            queue_list = []
            for s in ps.get("queue", []):
                queue_list.append({
                    "videoId": s.get("videoId", ""),
                    "title": s.get("title", "Untitled Track"),
                    "artist": s.get("artist", "Unknown Artist"),
                    "thumbnail": s.get("thumbnail", ""),
                    "duration": parse_duration(s.get("duration")),
                    "metadata": {}
                })
                
            current_song = None
            cs = ps.get("currentSong")
            if cs:
                current_song = {
                    "videoId": cs.get("videoId", ""),
                    "title": cs.get("title", "Untitled Track"),
                    "artist": cs.get("artist", "Unknown Artist"),
                    "thumbnail": cs.get("thumbnail", ""),
                    "duration": parse_duration(cs.get("duration")),
                    "metadata": {}
                }

            player_doc = {
                "_id": ObjectId(ps_id),
                "userId": userId,
                "deviceId": ps.get("deviceId", "default-device"),
                "currentSong": current_song,
                "queue": queue_list,
                "volume": float(ps.get("volume", 80)) / 100.0 if isinstance(ps.get("volume"), int) else float(ps.get("volume", 0.8)),
                "currentTime": float(ps.get("currentTime", 0.0))
            }
            migrated_player_states.append(player_doc)
            
        if migrated_player_states:
            await database[db.PLAYER_STATES].delete_many({})
            await database[db.PLAYER_STATES].insert_many(migrated_player_states)
            results["player_states"] = len(migrated_player_states)

    # 7. Migrate Share Links
    shares_data = load_json_file(os.path.join(json_dir, "yuzone-music.shares.json"))
    if shares_data:
        migrated_shares = []
        for sh in shares_data:
            sh_id = parse_bson_id(sh.get("_id"))
            userId = parse_bson_id(sh.get("userId"))
            
            share_doc = {
                "_id": ObjectId(sh_id),
                "userId": userId,
                "contentType": sh.get("contentType", "song"),
                "contentId": parse_bson_id(sh.get("contentId")),
                "shareToken": sh.get("shareToken", ""),
                "views": sh.get("views", 0),
                "expiry": parse_bson_date(sh.get("expiry")) if sh.get("expiry") else None
            }
            migrated_shares.append(share_doc)
            
        if migrated_shares:
            await database[db.SHARES].delete_many({})
            await database[db.SHARES].insert_many(migrated_shares)
            results["shares"] = len(migrated_shares)

    return results
