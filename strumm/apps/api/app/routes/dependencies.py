from fastapi import Depends, Header, HTTPException, status
from app.database import mongodb as db
from app.services.auth_utils import decode_access_token
from app.services.security import parse_object_id
from bson import ObjectId
from pymongo.errors import PyMongoError

async def get_current_user(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing"
        )
        
    try:
        scheme, token = authorization.split(" ")
        if scheme.lower() != "bearer":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication scheme"
            )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization format"
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
