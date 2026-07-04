import os
import time
import uuid
import shutil
import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.database import mongodb as db
from app.routes import auth, stream, lyrics, playlist, user, podcast, recommendation, share, social
from app.services.migration import run_yuzone_migration
from app.services.security import require_admin
from app.services.realtime.websocket import router as realtime_router
import logging

# Setup Logging
class RequestIDFilter(logging.Filter):
    """Log filter that adds request_id from the current request context."""
    def filter(self, record):
        if not hasattr(record, 'request_id'):
            record.request_id = getattr(thread_local, 'request_id', 'system')
        return True

import threading
thread_local = threading.local()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s [%(request_id)s]: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
for handler in logging.getLogger().handlers:
    handler.addFilter(RequestIDFilter())

logger = logging.getLogger("strumm-api")

# Disk storage threshold
MAX_DISK_MB = 512
DISK_WARNING_THRESHOLD = 0.80  # Warn at 80% usage


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup tasks run, then app serves, then shutdown."""
    t_start = time.time()
    logger.info("=== Application startup beginning ===")

    # 1. Connect to MongoDB (non-blocking, motor handles it lazily)
    db.connect_db()
    logger.info(f"MongoDB client created in {time.time() - t_start:.3f}s.")

    # 2. Launch heavy initialization as background task so server starts accepting immediately
    asyncio.create_task(_background_startup_work())

    yield  # App serves requests here

    # Shutdown
    db.close_db()
    logger.info("Application shutdown complete.")


async def _background_startup_work():
    """Heavy lifting that must NOT block the app from accepting requests."""
    t0 = time.time()

    # Brief pause so the server can bind before DB work
    await asyncio.sleep(0.1)

    try:
        logger.info(f"[{time.time() - t0:.3f}s] Beginning background initialization...")
        database = db.get_db()

        # --- Database indexes (non-critical) ---
        await _create_indexes(database)
        logger.info(f"[{time.time() - t0:.3f}s] Database indexes created.")

        # --- Disk usage check ---
        _check_disk_usage()

        # --- Stats are recalculated live on each play-event ---
        # (No longer running a 24-hour background refresher for all users.)

        logger.info(f"[{time.time() - t0:.3f}s] Background initialization complete. App is fully ready.")
    except Exception as e:
        logger.error(f"Background initialization failed (app continues serving): {e}")


async def _create_indexes(database):
    """Create all MongoDB indexes. Fails gracefully."""
    try:
        await database[db.USERS].create_index("email", unique=True)
        await database[db.USERS].create_index("username", unique=True)
        await database[db.PLAYBACK_HISTORIES].create_index([("userId", 1), ("playedAt", -1)])
        await database[db.PLAYBACK_HISTORIES].create_index([("song.videoId", 1)])
        await database[db.PLAYLISTS].create_index("userId")
        await database[db.PLAYLISTS].create_index([("name", 1), ("visibility", 1)])
        await database[db.PLAYLISTS].create_index("songs.videoId")
        await database[db.LIKED_SONGS].create_index([("userId", 1), ("song.videoId", 1)])
        await database[db.SHARES].create_index("expiry", expireAfterSeconds=0)
        await database[db.PODCAST_SHOWS].create_index("rss", unique=True, sparse=True)
        await database[db.PODCAST_EPISODES].create_index("showId")
        await database[db.PODCAST_EPISODES].create_index([("showId", 1), ("publishedAt", -1)])
        await database["lyrics_cache"].create_index("videoId", unique=True, sparse=True)
        await database[db.CONNECTIONS].create_index("requesterId")
        await database[db.CONNECTIONS].create_index("receiverId")
        await database[db.CONNECTIONS].create_index([("requesterId", 1), ("receiverId", 1)])
        await database[db.ACTIVITIES].create_index("expiresAt", expireAfterSeconds=0)
        await database[db.ACTIVITIES].create_index("userId")
        await database[db.NOTIFICATIONS].create_index("userId")
        await database[db.NOTIFICATIONS].create_index([("userId", 1), ("createdAt", -1)])
        await database[db.ROOMS].create_index("hostId")
        await database["follows"].create_index([("userId", 1), ("contentType", 1)])
    except Exception as e:
        logger.warning(f"Index creation failed (non-fatal): {e}")


app = FastAPI(
    title="Strumm API",
    description="Backend services for the premium handcrafted Strumm music ecosystem.",
    version="1.0.0",
    lifespan=lifespan,
)

def get_allowed_origins():
    origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    origins = [origin.strip() for origin in origins_str.split(",") if origin.strip()]
    # App domain from env var (set on Render: https://strumm.me)
    app_origin = os.getenv("STRUMM_APP_URL", "http://localhost:3000").rstrip("/")
    always_allowed = [app_origin, "http://localhost:5173", "http://localhost:3000"]

    # Explicitly add production origins so CORS works regardless of env var configuration
    production_origins = [
        "https://strumm.me",
        "https://www.strumm.me",
    ]
    for prod_origin in production_origins:
        if prod_origin not in origins:
            origins.append(prod_origin)

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

    logger.debug("Allowed CORS origins: %s", origins)
    return origins

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-endpoint rate limiting configuration
RATE_LIMITS = [
    # (path_prefix, max_requests, window_seconds)
    (["/auth/login"], 5, 60),               # Login: 5 per minute
    (["/auth/signup"], 3, 60),              # Signup: 3 per minute
    (["/auth/forgot-password"], 3, 60),     # Forgot password: 3 per minute
    (["/auth/email", "/auth/google"], 5, 60),  # OTP/Google auth: 5 per minute
    (["/auth/verify"], 10, 60),             # OTP verify: 10 per minute
    (["/auth/refresh", "/auth/logout"], 30, 60),  # Session ops: 30 per minute
    (["/search"], 30, 60),                  # Search: 30 per minute
    (["/recommend"], 20, 60),               # Recommendations: 20 per minute
    (["/explore-chat"], 15, 60),            # AI Chat: 15 per minute
    (["/playlist"], 30, 60),                # Playlist CRUD: 30 per minute
    (["/friends"], 20, 60),                 # Friend requests: 20 per minute
    (["/profile"], 20, 60),                 # Profile operations: 20 per minute
]

# General API limit (fallback for all other routes)
GENERAL_MAX = 100
GENERAL_WINDOW = 10


class PerEndpointRateLimiter:
    """Per-endpoint rate limiter with separate quotas for different route prefixes.
    Falls back to the general limit for unmatched routes.
    Uses LRU eviction to limit memory usage.
    """
    def __init__(self, max_clients: int = 1000):
        self._max_clients = max_clients
        # Nested dict: {client_ip: {limit_key: [timestamps]}}
        self._clients: dict[str, OrderedDict[str, list[float]]] = {}

    def _get_limit_for_path(self, path: str) -> tuple[int, int]:
        norm_path = path.rstrip("/")
        for prefixes, max_req, window in RATE_LIMITS:
            for prefix in prefixes:
                if norm_path.startswith(prefix):
                    return max_req, window
        return GENERAL_MAX, GENERAL_WINDOW

    def _cleanup(self, client_ip: str, limit_key: str, window_seconds: int, current_time: float):
        """Remove expired timestamps for a specific client and limit."""
        if client_ip in self._clients and limit_key in self._clients[client_ip]:
            timestamps = self._clients[client_ip][limit_key]
            cutoff = current_time - window_seconds
            remaining = [t for t in timestamps if t > cutoff]
            if remaining:
                self._clients[client_ip][limit_key] = remaining
                self._clients[client_ip].move_to_end(limit_key)
            else:
                del self._clients[client_ip][limit_key]
                if not self._clients[client_ip]:
                    del self._clients[client_ip]

    def _evict_if_full(self):
        while len(self._clients) > self._max_clients:
            self._clients.pop(next(iter(self._clients)))

    def is_rate_limited(self, client_ip: str, path: str) -> bool:
        current_time = time.time()
        max_requests, window_seconds = self._get_limit_for_path(path)
        limit_key = f"{max_requests}/{window_seconds}"

        self._cleanup(client_ip, limit_key, window_seconds, current_time)

        if client_ip not in self._clients:
            self._clients[client_ip] = OrderedDict()

        timestamps = self._clients[client_ip].get(limit_key, [])
        if len(timestamps) >= max_requests:
            return True

        timestamps.append(current_time)
        self._clients[client_ip][limit_key] = timestamps
        self._clients[client_ip].move_to_end(limit_key)
        self._evict_if_full()
        return False


rate_limiter = PerEndpointRateLimiter()

# Request ID middleware — assigns a unique ID to every request for traceability
@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    thread_local.request_id = request_id
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        thread_local.request_id = ""

@app.middleware("http")
async def rate_limiting_middleware(request: Request, call_next):
    client_ip = request.client.host if request.client else "127.0.0.1"
    path = request.url.path
    if rate_limiter.is_rate_limited(client_ip, path):
        req_id = request.headers.get("X-Request-ID", "unknown")
        logger.warning(f"Rate limit exceeded for {client_ip} on {path} [req_id={req_id}]")
        return JSONResponse(
            status_code=429,
            content={"success": False, "error": "Rate limit exceeded. Please slow down."}
        )
    response = await call_next(request)
    return response

# Register Routers
app.include_router(auth.router)
app.include_router(stream.router)
app.include_router(lyrics.router)
app.include_router(playlist.router)
app.include_router(user.router)
app.include_router(podcast.router)
app.include_router(recommendation.router)
app.include_router(share.router)
app.include_router(social.router)

# WebSocket realtime router (global connection at /ws)
app.include_router(realtime_router)

# Lightweight health endpoints — never query MongoDB, always respond in <10ms
@app.get("/")
async def root():
    """Root health probe for HF Spaces / Render."""
    return {"status": "ok", "service": "Strumm API"}


@app.api_route("/health", methods=["GET", "HEAD"])
async def health_check(request: Request):
    """Lightweight liveness probe. No DB calls."""
    if request.method == "HEAD":
        return Response(status_code=200)
    return {"status": "healthy"}


@app.api_route("/health/db", methods=["GET"])
async def health_check_db():
    """Detailed health check that probes MongoDB. Only call this for diagnostics."""
    try:
        database = db.get_db()
        await database.list_collection_names()
        return {
            "success": True,
            "data": {
                "status": "healthy",
                "database": "connected"
            }
        }
    except Exception as e:
        logger.error(f"DB health check failed: {str(e)}")
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
