import os
import time
import shutil
from collections import OrderedDict
from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.database import mongodb as db
from app.routes import auth, search, stream, lyrics, playlist, user, podcast, recommendation, share, social
from app.services.migration import run_yuzone_migration
from app.services.security import require_admin
import logging

# Setup Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("strumm-api")

# Disk storage threshold
MAX_DISK_MB = 512
DISK_WARNING_THRESHOLD = 0.80  # Warn at 80% usage

app = FastAPI(
    title="Strumm API",
    description="Backend services for the premium handcrafted Strumm music ecosystem.",
    version="1.0.0"
)

def get_allowed_origins():
    origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    origins = [origin.strip() for origin in origins_str.split(",") if origin.strip()]
    # App domain from env var (set on Render: https://strumm.me)
    app_origin = os.getenv("STRUMM_APP_URL", "http://localhost:3000").rstrip("/")
    always_allowed = [app_origin, "http://localhost:5173", "http://localhost:3000"]
    # Auto-add www variant if not already present (covers both strumm.me and www.strumm.me)
    from urllib.parse import urlparse
    parsed = urlparse(app_origin)
    if parsed.hostname and not parsed.hostname.startswith("www."):
        www_origin = f"{parsed.scheme}://www.{parsed.hostname}"
        if parsed.port:
            www_origin += f":{parsed.port}"
        if www_origin not in origins:
            origins.append(www_origin)
    elif parsed.hostname and parsed.hostname.startswith("www."):
        bare_origin = f"{parsed.scheme}://{parsed.hostname[4:]}"
        if parsed.port:
            bare_origin += f":{parsed.port}"
        if bare_origin not in origins:
            origins.append(bare_origin)
    for origin in always_allowed:
        if origin not in origins:
            origins.append(origin)
    return origins

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Efficient Rate Limiting Middleware using LRU with TTL
class RateLimiter:
    def __init__(self, max_requests: int = 100, window_seconds: int = 10, max_clients: int = 500):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._clients: OrderedDict[str, list[float]] = OrderedDict()
        self._max_clients = max_clients

    def _cleanup(self, client_ip: str, current_time: float):
        """Remove expired timestamps for a client."""
        if client_ip in self._clients:
            timestamps = self._clients[client_ip]
            cutoff = current_time - self.window_seconds
            self._clients[client_ip] = [t for t in timestamps if t > cutoff]
            if not self._clients[client_ip]:
                del self._clients[client_ip]
                return True
        return False

    def _evict_if_full(self):
        while len(self._clients) > self._max_clients:
            self._clients.popitem(last=False)

    def is_rate_limited(self, client_ip: str) -> bool:
        current_time = time.time()
        self._cleanup(client_ip, current_time)

        timestamps = self._clients.get(client_ip, [])
        if len(timestamps) >= self.max_requests:
            return True

        timestamps.append(current_time)
        self._clients[client_ip] = timestamps
        self._clients.move_to_end(client_ip)
        self._evict_if_full()
        return False


rate_limiter = RateLimiter()

@app.middleware("http")
async def rate_limiting_middleware(request: Request, call_next):
    client_ip = request.client.host if request.client else "127.0.0.1"
    if rate_limiter.is_rate_limited(client_ip):
        return JSONResponse(
            status_code=429,
            content={"success": False, "error": "Rate limit exceeded. Please slow down."}
        )
    response = await call_next(request)
    return response

# DB Connection Management
@app.on_event("startup")
async def startup_db_client():
    db.connect_db()
    try:
        database = db.get_db()
        # Create users indexes
        await database[db.USERS].create_index("email", unique=True)
        await database[db.USERS].create_index("username", unique=True)

        # History indexes
        await database[db.PLAYBACK_HISTORIES].create_index([("userId", 1), ("playedAt", -1)])
        await database[db.PLAYBACK_HISTORIES].create_index([("song.videoId", 1)])

        # Playlists indexes
        await database[db.PLAYLISTS].create_index("userId")
        await database[db.PLAYLISTS].create_index([("name", 1), ("visibility", 1)])
        await database[db.PLAYLISTS].create_index("songs.videoId")

        # Liked songs indexes
        await database[db.LIKED_SONGS].create_index([("userId", 1), ("song.videoId", 1)])

        # Shares TTL index
        await database[db.SHARES].create_index("expiry", expireAfterSeconds=0)

        # Podcast indexes
        await database[db.PODCAST_SHOWS].create_index("rss", unique=True, sparse=True)
        await database[db.PODCAST_EPISODES].create_index("showId")
        await database[db.PODCAST_EPISODES].create_index([("showId", 1), ("publishedAt", -1)])

        # Lyrics cache index
        await database["lyrics_cache"].create_index("videoId", unique=True, sparse=True)

        # Social indexes
        await database["connections"].create_index("requesterId")
        await database["connections"].create_index("receiverId")
        await database["connections"].create_index([("requesterId", 1), ("receiverId", 1)])
        await database["activities"].create_index("expiresAt", expireAfterSeconds=0)
        await database["activities"].create_index("userId")
        await database["notifications"].create_index("userId")
        await database["notifications"].create_index([("userId", 1), ("createdAt", -1)])

        # Room indexes
        await database["rooms"].create_index("hostId")

        # Follows indexes
        await database["follows"].create_index([("userId", 1), ("contentType", 1)])

        logger.info("Successfully initialized database indexes.")

        # Check disk usage on startup
        _check_disk_usage()

        # Launch daily statistics refresher loop
        import asyncio
        asyncio.create_task(user.daily_stats_refresher())
        logger.info("Daily Sound DNA & statistics refresher background task launched.")
    except Exception as e:
        logger.error(f"Error initializing indexes on startup: {str(e)}")

@app.on_event("shutdown")
async def shutdown_db_client():
    db.close_db()

# Register Routers
app.include_router(auth.router)
app.include_router(search.router)
app.include_router(stream.router)
app.include_router(lyrics.router)
app.include_router(playlist.router)
app.include_router(user.router)
app.include_router(podcast.router)
app.include_router(recommendation.router)
app.include_router(share.router)
app.include_router(social.router)

# Health checks
@app.api_route("/health", methods=["GET", "HEAD"])
async def health_check(request: Request):
    try:
        database = db.get_db()
        await database.list_collection_names()
        if request.method == "HEAD":
            return Response(status_code=200)
        return {
            "success": True,
            "data": {
                "status": "healthy",
                "database": "connected"
            }
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        if request.method == "HEAD":
            return Response(status_code=503)
        return JSONResponse(
            status_code=503,
            content={"success": False, "error": f"Service unhealthy: {str(e)}"}
        )

def _check_disk_usage() -> None:
    """Log a warning if disk usage exceeds 80% of 512MB max."""
    try:
        total, used, free = shutil.disk_usage("/")
        used_mb = used // (1024 * 1024)
        total_mb = total // (1024 * 1024)
        used_pct = used / total * 100
        logger.info(f"Disk usage: {used_mb}MB / {total_mb}MB ({used_pct:.1f}%)")
        if used_pct > DISK_WARNING_THRESHOLD * 100:
            logger.warning(
                f"DISK USAGE WARNING: {used_pct:.1f}% used ({used_mb}MB / {total_mb}MB). "
                f"Render free tier limit is {MAX_DISK_MB}MB. Consider cleaning up or upgrading."
            )
    except Exception as e:
        logger.warning(f"Could not check disk usage: {e}")


async def disk_health():
    """Return filesystem disk usage. Helps monitor Render 512MB ephemeral storage."""
    try:
        total, used, free = shutil.disk_usage("/")
        used_mb = used // (1024 * 1024)
        free_mb = free // (1024 * 1024)
        total_mb = total // (1024 * 1024)
        used_pct = round(used / total * 100, 1)
        return {
            "success": True,
            "data": {
                "total_mb": total_mb,
                "used_mb": used_mb,
                "free_mb": free_mb,
                "used_pct": used_pct,
                "max_render_mb": MAX_DISK_MB,
                "status": "ok" if used_pct < DISK_WARNING_THRESHOLD * 100 else "warning",
            }
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Cannot read disk usage: {str(e)}"}
        )


# Migration Trigger endpoint
@app.post("/migration/run")
async def trigger_migration(
    _: None = Depends(require_admin)
):
    try:
        absolute_json_path = os.path.abspath(os.getenv("MIGRATION_JSON_DIR", "../../json"))
        logger.info(f"Migration: loading data from {absolute_json_path}")
        migrated_counts = await run_yuzone_migration(absolute_json_path)
        return {
            "success": True,
            "data": {
                "message": "Migration completed successfully.",
                "details": migrated_counts
            }
        }
    except Exception as e:
        logger.error(f"Migration failed: {str(e)}")
        return {"success": False, "error": f"Migration execution aborted: {str(e)}"}


# Register disk health route directly (not via router module)
app.api_route("/health/disk", methods=["GET"])(disk_health)


# --- Sitemap endpoint (public, no auth required) ---

@app.get("/sitemap")
async def sitemap_data():
    """Return all indexable URLs for SEO sitemap generation.
    No auth required — used by the frontend at build time.
    """
    try:
        database = db.get_db()
        songs = []
        playlists = []
        podcasts = []
        users = []

        # 1. Collect unique song videoIds from all collections
        seen_video_ids = set()

        # From playlists
        playlist_cursor = database[db.PLAYLISTS].find(
            {"songs": {"$exists": True, "$ne": []}},
            {"songs.videoId": 1, "songs.title": 1}
        )
        async for doc in playlist_cursor:
            for song in doc.get("songs", []):
                vid = song.get("videoId")
                if vid and vid not in seen_video_ids:
                    seen_video_ids.add(vid)
                    songs.append({
                        "videoId": vid,
                        "title": song.get("title", "")
                    })

        # From liked songs
        liked_cursor = database[db.LIKED_SONGS].find(
            {},
            {"song.videoId": 1, "song.title": 1}
        )
        async for doc in liked_cursor:
            s = doc.get("song", {})
            vid = s.get("videoId")
            if vid and vid not in seen_video_ids:
                seen_video_ids.add(vid)
                songs.append({
                    "videoId": vid,
                    "title": s.get("title", "")
                })

        # 2. Collect public playlists
        playlist_list_cursor = database[db.PLAYLISTS].find(
            {"visibility": "public"},
            {"_id": 1, "name": 1}
        )
        async for doc in playlist_list_cursor:
            playlists.append({
                "id": str(doc["_id"]),
                "name": doc.get("name", "")
            })

        # 3. Collect podcast shows
        podcast_cursor = database[db.PODCAST_SHOWS].find(
            {},
            {"_id": 1, "title": 1}
        )
        async for doc in podcast_cursor:
            podcasts.append({
                "id": str(doc["_id"]),
                "title": doc.get("title", "")
            })

        # 4. Collect public user profiles
        user_cursor = database[db.USERS].find(
            {},
            {"username": 1, "displayName": 1}
        )
        async for doc in user_cursor:
            username = doc.get("username")
            if username:
                users.append({
                    "username": username,
                    "displayName": doc.get("displayName", "")
                })

        return {
            "success": True,
            "data": {
                "songs": songs,
                "playlists": playlists,
                "podcasts": podcasts,
                "users": users,
                "counts": {
                    "songs": len(songs),
                    "playlists": len(playlists),
                    "podcasts": len(podcasts),
                    "users": len(users),
                    "total": len(songs) + len(playlists) + len(podcasts) + len(users)
                }
            }
        }
    except Exception as e:
        logger.error(f"Error generating sitemap data: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )
