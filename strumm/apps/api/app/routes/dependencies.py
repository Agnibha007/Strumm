from fastapi import Depends, Header, HTTPException, status, Cookie, BackgroundTasks
from typing import Optional
from datetime import datetime
from app.database import mongodb as db
from app.services.auth_utils import decode_access_token
from app.services.security import parse_object_id
from app.services import get_cached_user, cache_user
from bson import ObjectId
from pymongo.errors import PyMongoError

async def update_last_active(user_id: str):
    database = db.get_db()
    try:
        await database[db.USERS].update_one(
            {"_id": parse_object_id(user_id)},
            {"$set": {"lastActive": datetime.utcnow()}}
        )
    except Exception:
        pass

async def get_current_user(
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    access_token: Optional[str] = Cookie(None)
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
        
    background_tasks.add_task(update_last_active, user_id)
    
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
        
    # Serialize ObjectId and dates
    user["id"] = str(user["_id"])
    del user["_id"]
    if "createdAt" in user and user["createdAt"]:
        if hasattr(user["createdAt"], "isoformat"):
            user["createdAt"] = user["createdAt"].isoformat()
        else:
            user["createdAt"] = str(user["createdAt"])
            
    # Cache user doc
    cache_user(cache_key, user)
    return user


async def get_optional_user(
    background_tasks: BackgroundTasks,
    authorization: str = Header(None),
    access_token: Optional[str] = Cookie(None)
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

    user["id"] = str(user["_id"])
    del user["_id"]
    if "createdAt" in user and user["createdAt"]:
        if hasattr(user["createdAt"], "isoformat"):
            user["createdAt"] = user["createdAt"].isoformat()
        else:
            user["createdAt"] = str(user["createdAt"])
            
    # Cache user doc
    cache_user(cache_key, user)
    return user
