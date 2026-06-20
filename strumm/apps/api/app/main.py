import os
import time
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.database import mongodb as db
from app.routes import auth, search, stream, lyrics, playlist, user, podcast, recommendation, share
from app.services.migration import run_yuzone_migration
from app.services.security import require_admin
import logging

# Setup Logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("strumm-api")

app = FastAPI(
    title="Strumm API",
    description="Backend services for the premium handcrafted Strumm music ecosystem.",
    version="1.0.0"
)

def get_allowed_origins():
    origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    return [origin.strip() for origin in origins.split(",") if origin.strip()]

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Basic Rate Limiting Middleware
request_times = {}

@app.middleware("http")
async def rate_limiting_middleware(request: Request, call_next):
    # Simple IP-based rate limiting
    client_ip = request.client.host
    current_time = time.time()
    if len(request_times) > 10000:
        stale_ips = [
            ip for ip, times in request_times.items()
            if not times or current_time - max(times) >= 10
        ]
        for ip in stale_ips:
            request_times.pop(ip, None)
    
    # Track requests in last 10 seconds
    if client_ip not in request_times:
        request_times[client_ip] = []
        
    # Clean old requests
    request_times[client_ip] = [t for t in request_times[client_ip] if current_time - t < 10]
    
    # Max 100 requests every 10 seconds
    if len(request_times[client_ip]) > 100:
        return JSONResponse(
            status_code=429,
            content={
                "success": False,
                "error": "Rate limit exceeded. Please slow down."
            }
        )
        
    request_times[client_ip].append(current_time)
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
        
        # Create history compound index: userId + playedAt
        await database[db.PLAYBACK_HISTORIES].create_index([("userId", 1), ("playedAt", -1)])
        
        # Create playlists index: userId
        await database[db.PLAYLISTS].create_index("userId")
        
        # Create shares TTL index: expiry
        await database[db.SHARES].create_index("expiry", expireAfterSeconds=0)
        logger.info("Successfully initialized database indexes and TTL.")
    except Exception as e:
        logger.error(f"Error establishing database indexes on startup: {str(e)}")

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

# Health checks
@app.get("/health")
async def health_check():
    try:
        # Check DB connectivity
        database = db.get_db()
        # Run a simple query to verify connection
        await database.list_collection_names()
        return {
            "success": True,
            "data": {
                "status": "healthy",
                "database": "connected"
            }
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "success": False,
            "error": f"Service unhealthy: {str(e)}"
        }

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
        return {
            "success": False,
            "error": f"Migration execution aborted: {str(e)}"
        }
