from fastapi import Depends, Header, HTTPException, status, Cookie
from typing import Optional
from app.database import mongodb as db
from app.services.auth_utils import decode_access_token
from app.services.security import parse_object_id
from bson import ObjectId
from pymongo.errors import PyMongoError

async def get_current_user(
    authorization: str = Header(None),
    access_token: Optional[str] = Cookie(None)
):
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
    return user
