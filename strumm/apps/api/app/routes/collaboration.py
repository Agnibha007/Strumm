import logging
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel
from bson import ObjectId
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.security import parse_object_id
from app.services.realtime.connection_manager import manager

logger = logging.getLogger("strumm-collab")
router = APIRouter(prefix="/playlists", tags=["collaboration"])


class PlaylistActivityEvent(BaseModel):
    """Model for playlist activity events."""
    event_type: str  # "song_added", "song_removed", "playlist_renamed", "collaborator_joined", "song_reordered"
    user_id: str
    username: str
    playlist_id: str
    timestamp: datetime
    details: dict = {}


class ActivityLog(BaseModel):
    """Database model for activity log entries."""
    playlistId: str
    userId: str
    username: str
    action: str
    timestamp: datetime
    details: dict = {}


class CollaborationService:
    """Service for handling collaborative playlist features."""

    @staticmethod
    async def log_activity(
        database,
        playlist_id: str,
        user_id: str,
        username: str,
        action: str,
        details: dict = None
    ):
        """Log a playlist activity event."""
        try:
            activity = {
                "playlistId": playlist_id,
                "userId": user_id,
                "username": username,
                "action": action,
                "timestamp": datetime.utcnow(),
                "details": details or {}
            }
            await database["playlist_activity"].insert_one(activity)
            
            # Broadcast to connected WebSocket clients using room-scoped connections
            # Playlists use room_id pattern: "playlist:{playlistId}"
            await manager.broadcast_to_room(
                f"playlist:{playlist_id}",
                {
                    "type": "activity",
                    "event": action,
                    "userId": user_id,
                    "username": username,
                    "timestamp": activity["timestamp"].isoformat(),
                    "details": details or {}
                }
            )
        except Exception as e:
            logger.error(f"Error logging activity: {str(e)}")

    @staticmethod
    async def get_activity_feed(
        database,
        playlist_id: str,
        limit: int = 50
    ) -> List[dict]:
        """Get activity feed for a playlist."""
        pipeline = [
            {
                "$match": {"playlistId": playlist_id}
            },
            {
                "$sort": {"timestamp": -1}
            },
            {
                "$limit": limit
            },
            {
                "$project": {
                    "_id": 0,
                    "userId": 1,
                    "username": 1,
                    "action": 1,
                    "timestamp": 1,
                    "details": 1
                }
            }
        ]

        cursor = database["playlist_activity"].aggregate(pipeline)
        activities = []
        async for doc in cursor:
            doc["timestamp"] = doc["timestamp"].isoformat()
            activities.append(doc)
        return activities

    @staticmethod
    async def get_active_editors(
        database,
        playlist_id: str
    ) -> List[dict]:
        """Get list of users currently editing a playlist from WebSocket connections."""
        # Get room_id for this playlist
        room_id = f"playlist:{playlist_id}"
        # This will be populated by WebSocket connections in the room
        return []


@router.get("/{id}/activity")
async def get_playlist_activity(
    id: str = Path(...),
    limit: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user)
):
    """Get activity feed for a playlist."""
    try:
        database = db.get_db()
        playlist_id = str(parse_object_id(id))
        
        # Verify user has access to the playlist
        playlist = await database[db.PLAYLISTS].find_one({"_id": ObjectId(playlist_id)})
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
        
        user_id = current_user["id"]
        is_owner = str(playlist.get("userId")) == user_id
        collaborators = playlist.get("collaborators", []) or []
        
        if not is_owner and user_id not in collaborators and playlist.get("visibility") != "public":
            return {"success": False, "error": "You don't have access to this playlist"}
        
        activities = await CollaborationService.get_activity_feed(
            database,
            playlist_id,
            limit
        )
        
        return {
            "success": True,
            "data": {
                "activities": activities,
                "count": len(activities)
            }
        }
    except Exception as e:
        logger.error(f"Error fetching playlist activity: {str(e)}")
        return {
            "success": False,
            "error": "Failed to fetch playlist activity"
        }


@router.get("/{id}/active-editors")
async def get_active_editors(
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    """Get list of users currently editing a playlist (real-time)."""
    try:
        database = db.get_db()
        playlist_id = str(parse_object_id(id))
        
        # Verify user has access
        playlist = await database[db.PLAYLISTS].find_one({"_id": ObjectId(playlist_id)})
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
        
        editors = await CollaborationService.get_active_editors(database, playlist_id)
        
        return {
            "success": True,
            "data": {
                "editors": editors,
                "count": len(editors)
            }
        }
    except Exception as e:
        logger.error(f"Error fetching active editors: {str(e)}")
        return {
            "success": False,
            "error": "Failed to fetch active editors"
        }


@router.get("/{id}/stats")
async def get_playlist_collaboration_stats(
    id: str = Path(...),
    current_user: dict = Depends(get_current_user)
):
    """Get collaboration statistics for a playlist."""
    try:
        database = db.get_db()
        playlist_id = str(parse_object_id(id))
        
        playlist = await database[db.PLAYLISTS].find_one({"_id": ObjectId(playlist_id)})
        if not playlist:
            return {"success": False, "error": "Playlist not found"}
        
        # Calculate stats
        collaborators = playlist.get("collaborators", []) or []
        songs = playlist.get("songs", []) or []
        
        # Get recent activity count (last 7 days)
        from datetime import timedelta
        cutoff = datetime.utcnow() - timedelta(days=7)
        
        recent_activities = await database["playlist_activity"].count_documents({
            "playlistId": playlist_id,
            "timestamp": {"$gte": cutoff}
        })
        
        # Get contributor count
        contributors_set = {str(playlist.get("userId"))}
        async for activity in database["playlist_activity"].find({"playlistId": playlist_id}):
            contributors_set.add(activity.get("userId", ""))
        
        return {
            "success": True,
            "data": {
                "total_collaborators": len(collaborators),
                "total_contributors": len(contributors_set),
                "total_songs": len(songs),
                "recent_activities": recent_activities,
                "created_at": playlist.get("createdAt", datetime.utcnow()).isoformat(),
                "last_modified": playlist.get("updatedAt", datetime.utcnow()).isoformat()
            }
        }
    except Exception as e:
        logger.error(f"Error fetching collaboration stats: {str(e)}")
        return {
            "success": False,
            "error": "Failed to fetch collaboration statistics"
        }
