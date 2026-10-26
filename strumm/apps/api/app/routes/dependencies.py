import logging
import os
from datetime import datetime
from typing import Optional

from bson import ObjectId
from fastapi import BackgroundTasks, Cookie, Depends, Header, HTTPException, Response, status
from pymongo.errors import PyMongoError

from app.database import mongodb as db
from app.services import cache_user, get_cached_user
from app.services.auth_utils import decode_access_token, SESSION_IDLE_TIMEOUT
from app.services.security import parse_object_id
from app.services.user_serializer import NEVER_FIELDS

logger = logging.getLogger("strumm-dependencies")


def _strip_credentials(user: dict) -> dict:
    """Drop any credential field present on a user document."""
    for field in NEVER_FIELDS:
        user.pop(field, None)
    return user


def _renew_refresh_cookie(response: Optional[Response], refresh_token: Optional[str]) -> None:
    if response is None or not refresh_token:
        return
    is_secure = os.getenv("ENVIRONMENT", "development").lower() != "development" or os.getenv("FORCE_SECURE_COOKIES") == "true"
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=is_secure,
        samesite="none" if is_secure else "lax",
        max_age=int(SESSION_IDLE_TIMEOUT.total_seconds()),
        path="/",
    )


async def update_last_active(user_id: str, session_id: Optional[str] = None):
    database = db.get_db()
    now = datetime.utcnow()
    try:
        await database[db.USERS].update_one(
            {"_id": parse_object_id(user_id)},
            {"$set": {"lastActive": now}},
        )
        if session_id and ObjectId.is_valid(session_id):
            await database[db.SESSIONS].update_one(
                {"_id": ObjectId(session_id), "userId": user_id},
                {"$set": {"lastActiveAt": now, "expiresAt": now + SESSION_IDLE_TIMEOUT}},
            )
    except Exception as e:
        logger.warning(
            "Failed to update lastActive for user %s: %s: %s",
            user_id,
            type(e).__name__,
            e,
        )


async def get_current_user(
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    access_token: Optional[str] = Cookie(None),
    refresh_token: Optional[str] = Cookie(None),
    response: Response = None,
):
    token = None
    if authorization:
        try:
            parts = authorization.split(" ")
            if len(parts) == 2 and parts[0].lower() == "bearer":
                token = parts[1]
        except ValueError:
            pass

    if not token and access_token:
        token = access_token

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization token missing"
        )

    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired or invalid token"
        )
        
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token content"
        )
        
    background_tasks.add_task(update_last_active, user_id, payload.get("sid"))
    if payload.get("sid"):
        _renew_refresh_cookie(response, refresh_token)
    
    # Check cache first
    cache_key = f"user:{user_id}"
    cached = get_cached_user(cache_key)
    if cached:
        return cached

    database = db.get_db()
    try:
        user = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
    except PyMongoError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is temporarily unavailable"
        )

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found"
        )
        
    # Never retain credential material in the authenticated-user object that is
    # cached and handed to every handler (SEC-01: password must not leave the
    # server, and must not be cacheable for accidental leak).
    _strip_credentials(user)

    # Serialize ObjectId and dates
    user["id"] = str(user["_id"])
    del user["_id"]
    if "createdAt" in user and user["createdAt"]:
        if hasattr(user["createdAt"], "isoformat"):
            user["createdAt"] = user["createdAt"].isoformat()
        else:
            user["createdAt"] = str(user["createdAt"])
            
    # Cache user doc. Return a copy so handlers mutating the dict they receive
    # (e.g. /profile decorating current_user["soundDNA"]) cannot poison the
    # cache entry for other requests within the TTL window.
    cache_user(cache_key, user)
    return user.copy()


async def get_optional_user(
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    access_token: Optional[str] = Cookie(None),
    refresh_token: Optional[str] = Cookie(None),
    response: Response = None,
):
    """Like get_current_user, but returns None instead of raising on missing/invalid token.
    Useful for endpoints where auth is optional (e.g., feedback submission).
    """
    token = None
    if access_token:
        token = access_token
    elif authorization:
        try:
            parts = authorization.split(" ")
            if len(parts) == 2 and parts[0].lower() == "bearer":
                token = parts[1]
        except ValueError:
            pass

    if not token:
        return None

    payload = decode_access_token(token)
    if not payload:
        return None

    user_id = payload.get("sub")
    if not user_id:
        return None

    background_tasks.add_task(update_last_active, user_id, payload.get("sid"))
    if payload.get("sid"):
        _renew_refresh_cookie(response, refresh_token)

    # Check cache first
    cache_key = f"user:{user_id}"
    cached = get_cached_user(cache_key)
    if cached:
        return cached

    database = db.get_db()
    try:
        user = await database[db.USERS].find_one({"_id": parse_object_id(user_id)})
    except PyMongoError:
        return None

    if not user:
        return None

    _strip_credentials(user)

    user["id"] = str(user["_id"])
    del user["_id"]
    if "createdAt" in user and user["createdAt"]:
        if hasattr(user["createdAt"], "isoformat"):
            user["createdAt"] = user["createdAt"].isoformat()
        else:
            user["createdAt"] = str(user["createdAt"])
            
    # Cache user doc
    cache_user(cache_key, user)
    return user.copy()
