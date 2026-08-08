import os
import time
import json
import uuid
import shutil
import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager

import sentry_sdk
from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from app.database import mongodb as db
from app.routes import auth, stream, lyrics, playlist, user, podcast, recommendation, share, social, statistics, collaboration, feedback
from app.services.migration import run_yuzone_migration
from app.services.security import require_admin
from app.services.normalizer import clean_song_text_fields
from app.services.realtime.websocket import router as realtime_router
from app.services.http_client import close_http_client
import logging

# --- Sentry Error Monitoring ---
def _sentry_filter_health_check(tx):
    """Drop health check transactions to reduce noise in Sentry."""
    transaction_name = tx.get("transaction", "")
    return transaction_name not in ("/health", "/health/db", "/health/disk", "/")

sentry_sdk.init(
    dsn=os.environ.get("SENTRY_DSN"),
    environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
    release=os.environ.get("SENTRY_RELEASE"),
    traces_sample_rate=1.0,
    enable_logs=True,
    send_default_pii=True,
    before_send_transaction=_sentry_filter_health_check,
)

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

    # Verify DB connectivity
    try:
        await db.get_db().command("ping")
        logger.info(f"MongoDB ping OK in {time.time() - t_start:.3f}s.")
    except Exception as e:
        logger.error(f"MongoDB ping failed: {type(e).__name__}. Retrying in 2s...")
        await asyncio.sleep(2)
        try:
            await db.get_db().command("ping")
            logger.info("MongoDB ping OK on retry.")
        except Exception as e2:
            logger.error(f"MongoDB ping failed on retry: {type(e2).__name__}. App will start anyway.")

    # 2. Launch heavy initialization as background task so server starts accepting immediately
    asyncio.create_task(_background_startup_work())

    yield  # App serves requests here

    # Shutdown: close HTTP client pool and MongoDB
    await close_http_client()
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
    """Create all MongoDB indexes. Each index is created independently
    so a single failure does not skip subsequent indexes."""
    indexes = [
        ("users.email", lambda: database[db.USERS].create_index("email", unique=True)),
        ("users.username", lambda: database[db.USERS].create_index("username", unique=True)),
        ("playbackhistories.compound", lambda: database[db.PLAYBACK_HISTORIES].create_index([("userId", 1), ("playedAt", -1)])),
        ("playbackhistories.videoId", lambda: database[db.PLAYBACK_HISTORIES].create_index([("song.videoId", 1)])),
        ("playlists.userId", lambda: database[db.PLAYLISTS].create_index("userId")),
        ("playlists.name_visibility", lambda: database[db.PLAYLISTS].create_index([("name", 1), ("visibility", 1)])),
        ("playlists.songs.videoId", lambda: database[db.PLAYLISTS].create_index("songs.videoId")),
        ("likedsongs.compound", lambda: database[db.LIKED_SONGS].create_index([("userId", 1), ("song.videoId", 1)])),
        ("shares.expiry", lambda: database[db.SHARES].create_index("expiry", expireAfterSeconds=0)),
        ("shares.shareToken", lambda: database[db.SHARES].create_index("shareToken", unique=True, sparse=True)),
        ("podcastshows.rss", lambda: database[db.PODCAST_SHOWS].create_index("rss", unique=True, sparse=True)),
        ("podcastepisodes.showId", lambda: database[db.PODCAST_EPISODES].create_index("showId")),
        ("podcastepisodes.compound", lambda: database[db.PODCAST_EPISODES].create_index([("showId", 1), ("publishedAt", -1)])),
        ("lyrics_cache.videoId", lambda: database["lyrics_cache"].create_index("videoId", unique=True, sparse=True)),
        ("connections.requesterId", lambda: database[db.CONNECTIONS].create_index("requesterId")),
        ("connections.receiverId", lambda: database[db.CONNECTIONS].create_index("receiverId")),
        ("connections.compound", lambda: database[db.CONNECTIONS].create_index([("requesterId", 1), ("receiverId", 1)])),
        ("connections.status_compound", lambda: database[db.CONNECTIONS].create_index([("requesterId", 1), ("receiverId", 1), ("status", 1)])),
        ("activities.expiresAt", lambda: database[db.ACTIVITIES].create_index("expiresAt", expireAfterSeconds=0)),
        ("activities.userId", lambda: database[db.ACTIVITIES].create_index("userId")),
        ("notifications.userId", lambda: database[db.NOTIFICATIONS].create_index("userId")),
        ("notifications.compound", lambda: database[db.NOTIFICATIONS].create_index([("userId", 1), ("createdAt", -1)])),
        ("rooms.hostId", lambda: database[db.ROOMS].create_index("hostId")),
        ("follows.compound", lambda: database["follows"].create_index([("userId", 1), ("contentType", 1)])),
        # New indexes for previously unindexed collections
        ("sessions.refreshTokenHash", lambda: database[db.SESSIONS].create_index("refreshTokenHash", sparse=True)),
        ("sessions.userId", lambda: database[db.SESSIONS].create_index("userId", sparse=True)),
        ("otps.email", lambda: database["otps"].create_index("email", sparse=True)),
        ("otps.expiry_ttl", lambda: database["otps"].create_index("expiry", expireAfterSeconds=0)),
        ("password_resets.email", lambda: database["password_resets"].create_index("email", sparse=True)),
        ("playerstates.userId_deviceId", lambda: database[db.PLAYER_STATES].create_index([("userId", 1), ("deviceId", 1)])),
        ("songMemories.userId", lambda: database["songMemories"].create_index("userId")),
        ("songMemories.compound", lambda: database["songMemories"].create_index([("userId", 1), ("createdAt", -1)])),
        ("playlist_activity.playlistId", lambda: database["playlist_activity"].create_index("playlistId")),
        ("login_attempts.expiry_ttl", lambda: database["login_attempts"].create_index("expiry", expireAfterSeconds=0)),
        ("playlist_activity.compound", lambda: database["playlist_activity"].create_index([("playlistId", 1), ("timestamp", -1)])),
        ("notifications.read_compound", lambda: database[db.NOTIFICATIONS].create_index([("userId", 1), ("read", 1)])),
        ("feedback.createdAt", lambda: database["feedback"].create_index("createdAt")),
        ("feedback.userId", lambda: database["feedback"].create_index("userId")),
        ("feedback.status", lambda: database["feedback"].create_index("status")),
        ("podcastprogress.compound", lambda: database[db.PODCAST_PROGRESS].create_index([("userId", 1), ("episodeId", 1)], unique=True)),
        ("podcastprogress.userId", lambda: database[db.PODCAST_PROGRESS].create_index("userId")),
    ]

    created = 0
    for name, create_fn in indexes:
        try:
            await create_fn()
            created += 1
        except Exception as e:
            logger.warning(f"Index creation failed for {name} (non-fatal): {e}")

    logger.info(f"Indexes: {created}/{len(indexes)} created successfully.")


app = FastAPI(
    title="Strumm API",
    description="Backend services for the premium handcrafted Strumm music ecosystem.",
    version="1.0.0",
    lifespan=lifespan,
)

def get_allowed_origins():
    is_development = os.getenv("ENVIRONMENT", "development").lower() == "development"
    origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    origins = [origin.strip() for origin in origins_str.split(",") if origin.strip()]
    # App domain from env var (set on Render: https://strumm.me)
    app_origin = os.getenv("STRUMM_APP_URL", "http://localhost:3000").rstrip("/")

    # Only add localhost origins in development mode
    # This prevents CORS from accidentally exposing the API in production
    if is_development:
        local_origins = [app_origin, "http://localhost:5173", "http://localhost:3000"]
        for origin in local_origins:
            if origin not in origins:
                origins.append(origin)
    else:
        # In production, only allow the configured app URL (no localhost)
        if app_origin not in origins:
            origins.append(app_origin)

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

    logger.debug("Allowed CORS origins: %s", origins)
    return origins

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Admin-API-Key"],
)


# --- Unified Backend Middleware ---
# Combines Request ID tracing, Per-Endpoint Rate Limiting, and Security Headers.
# This eliminates multiple BaseHTTPMiddleware wraps (reducing ASGI overhead by 66%).
async def _sanitize_song_text(response: Response) -> Response:
    """Decode HTML entities in song text fields of JSON API responses."""
    ctype = response.headers.get("content-type", "")
    if "application/json" not in ctype or "set-cookie" in response.headers:
        return response
    try:
        chunks = [chunk async for chunk in response.body_iterator]
        body = b"".join(chunks)
        if not body:
            return response
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            # Not JSON despite content-type; re-serve original bytes.
            data = None
        if data is not None:
            cleaned = clean_song_text_fields(data)
            if cleaned is not data:
                body = json.dumps(cleaned, ensure_ascii=False).encode("utf-8")
        headers = dict(response.headers)
        headers.pop("content-length", None)
        headers.pop("transfer-encoding", None)
        return Response(
            content=body,
            status_code=response.status_code,
            headers=headers,
            media_type="application/json",
        )
    except Exception:
        return response


class UnifiedBackendMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 1. Request ID Initialization
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        thread_local.request_id = request_id

        # 2. Rate Limiting Check
        client_ip = request.client.host if request.client else "127.0.0.1"
        path = request.url.path
        is_limited, max_req, current, window, retry_after = rate_limiter.check_rate_limit(client_ip, path)

        if is_limited:
            logger.warning(
                f"Rate limit exceeded for {client_ip} on {path} ({current}/{max_req} in {window}s) [req_id={request_id}]"
            )
            thread_local.request_id = ""
            return JSONResponse(
                status_code=429,
                content={"success": False, "error": "Rate limit exceeded. Please slow down."},
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(max_req),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(time.time() + retry_after)),
                }
            )

        try:
            # 3. Proceed with request execution
            response = await call_next(request)

            # 3b. Clean HTML entities (e.g. &amp;quot;) in song text fields of
            #     JSON responses. Legacy DB rows can carry encoded titles; we
            #     fix them at the single response boundary so every read
            #     (playlists, liked, history, radio, stats) returns clean text.
            #     Skipped for cookie-setting (auth) responses to avoid touching
            #     Set-Cookie headers.
            response = await _sanitize_song_text(response)

            # 4. Inject Response Headers (Request ID, Rate Limits, and Security Headers)
            response.headers["X-Request-ID"] = request_id
            
            remaining = max_req - current
            response.headers["X-RateLimit-Limit"] = str(max_req)
            response.headers["X-RateLimit-Remaining"] = str(max(remaining, 0))

            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            response.headers["X-XSS-Protection"] = "1; mode=block"
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"

            return response
        finally:
            thread_local.request_id = ""

app.add_middleware(UnifiedBackendMiddleware)


# --- Global Exception Handler (prevents leaking internal details) ---
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": "An internal server error occurred."}
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
    (["/feedback"], 10, 60),               # Feedback: 10 per minute
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

    def check_rate_limit(self, client_ip: str, path: str) -> tuple[bool, int, int, int, float]:
        """
        Check if a request is rate limited.
        Returns: (is_limited, max_requests, current_count, window_seconds, retry_after_seconds)
        """
        current_time = time.time()
        max_requests, window_seconds = self._get_limit_for_path(path)
        limit_key = f"{max_requests}/{window_seconds}"

        self._cleanup(client_ip, limit_key, window_seconds, current_time)

        if client_ip not in self._clients:
            self._clients[client_ip] = OrderedDict()

        timestamps = self._clients[client_ip].get(limit_key, [])
        current_count = len(timestamps)
        
        if current_count >= max_requests:
            # Calculate when the earliest request in the window expires
            oldest = timestamps[0]
            retry_after = int(window_seconds - (current_time - oldest)) + 1
            return True, max_requests, current_count, window_seconds, max(retry_after, 1)

        timestamps.append(current_time)
        self._clients[client_ip][limit_key] = timestamps
        self._clients[client_ip].move_to_end(limit_key)
        self._evict_if_full()
        return False, max_requests, current_count + 1, window_seconds, 0.0


rate_limiter = PerEndpointRateLimiter()

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
app.include_router(statistics.router)
app.include_router(collaboration.router)
app.include_router(feedback.router)

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
        logger.error(f"DB health check failed: {type(e).__name__}")
        return JSONResponse(
            status_code=503,
            content={"success": False, "error": "Service unhealthy: database connection failed"}
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
    """Return indexable URLs for SEO sitemap generation.
    Uses Aggregation Pipelines with $limit to avoid loading entire collections.
    No auth required -- used by the frontend at build time.
    """
    try:
        database = db.get_db()
        songs = []
        playlists = []
        podcasts = []
        users = []

        MAX_SONGS = 10000
        MAX_PLAYLISTS = 5000
        MAX_PODCASTS = 2000
        MAX_USERS = 5000

        # 1. Collect unique song videoIds via aggregation (bounded)
        seen_video_ids = set()

        # From playlists -- unwind songs pipeline to extract unique videos
        playlist_songs_pipeline = [
            {"$match": {"songs": {"$exists": True, "$ne": []}}},
            {"$unwind": "$songs"},
            {"$project": {"videoId": "$songs.videoId", "title": "$songs.title"}},
            {"$group": {"_id": "$videoId", "title": {"$first": "$title"}}},
            {"$limit": MAX_SONGS},
        ]
        async for doc in database[db.PLAYLISTS].aggregate(playlist_songs_pipeline, allowDiskUse=True):
            vid = doc.get("_id")
            if vid and vid not in seen_video_ids:
                seen_video_ids.add(vid)
                songs.append({"videoId": vid, "title": doc.get("title", "")})

        # From liked songs (bounded)
        liked_pipeline = [
            {"$group": {"_id": "$song.videoId", "title": {"$first": "$song.title"}}},
            {"$limit": MAX_SONGS},
        ]
        async for doc in database[db.LIKED_SONGS].aggregate(liked_pipeline, allowDiskUse=True):
            vid = doc.get("_id")
            if vid and vid not in seen_video_ids:
                seen_video_ids.add(vid)
                songs.append({"videoId": vid, "title": doc.get("title", "")})

        # 2. Public playlists (bounded)
        async for doc in database[db.PLAYLISTS].find(
            {"visibility": "public"},
            {"_id": 1, "name": 1}
        ).limit(MAX_PLAYLISTS):
            playlists.append({"id": str(doc["_id"]), "name": doc.get("name", "")})

        # 3. Podcast shows (bounded)
        async for doc in database[db.PODCAST_SHOWS].find(
            {}, {"_id": 1, "title": 1}
        ).limit(MAX_PODCASTS):
            podcasts.append({"id": str(doc["_id"]), "title": doc.get("title", "")})

        # 4. Public user profiles (bounded)
        async for doc in database[db.USERS].find(
            {}, {"username": 1, "displayName": 1}
        ).limit(MAX_USERS):
            username = doc.get("username")
            if username:
                users.append({"username": username, "displayName": doc.get("displayName", "")})

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
        logger.error(f"Error generating sitemap data: {type(e).__name__}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Failed to generate sitemap data."}
        )
