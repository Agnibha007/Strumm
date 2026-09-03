import logging
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from app.database import mongodb as db
from app.routes.dependencies import get_current_user
from app.services.avatar import decorate_user_avatar
from bson import ObjectId

logger = logging.getLogger("strumm-statistics")
router = APIRouter(prefix="/stats", tags=["statistics"])


class StatisticsService:
    """Service for computing user listening statistics."""
    
    @staticmethod
    async def get_listening_time_stats(
        user_id: str,
        database,
        days: int = 30
    ) -> dict:
        """Get listening time stats for the past N days."""
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        pipeline = [
            {
                "$match": {
                    "userId": ObjectId(user_id),
                    "playedAt": {"$gte": cutoff_date}
                }
            },
            {
                "$group": {
                    "_id": {
                        "date": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$playedAt"
                            }
                        }
                    },
                    "totalSeconds": {
                        "$sum": "$listenDuration"
                    },
                    "songCount": {"$sum": 1}
                }
            },
            {
                "$sort": {"_id.date": 1}
            }
        ]
        
        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
        results = []
        total_seconds = 0
        
        async for doc in cursor:
            total_seconds += doc.get("totalSeconds", 0)
            results.append({
                "date": doc["_id"]["date"],
                "minutesListened": doc["totalSeconds"] // 60,
                "hoursListened": doc["totalSeconds"] / 3600,
                "songCount": doc["songCount"]
            })
        
        return {
            "period_days": days,
            "total_minutes": total_seconds // 60,
            "total_hours": total_seconds / 3600,
            "avg_daily_minutes": (total_seconds // 60) // max(days, 1),
            "daily_breakdown": results
        }
    
    @staticmethod
    async def get_genre_stats(
        user_id: str,
        database,
        days: int = 30
    ) -> dict:
        """Get genre breakdown of listening."""
        cutoff_date = datetime.utcnow() - timedelta(days=days)

        pipeline = [
            {
                "$match": {
                    "userId": ObjectId(user_id),
                    "playedAt": {"$gte": cutoff_date}
                }
            },
            {
                "$group": {
                    "_id": {"$ifNull": ["$song.metadata.genre", "Unknown"]},
                    "playCount": {"$sum": 1},
                    "totalSeconds": {"$sum": "$listenDuration"}
                }
            }
        ]

        genre_map = {}
        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
        async for doc in cursor:
            genre = doc.get("_id") or "Unknown"
            if genre not in genre_map:
                genre_map[genre] = {"plays": 0, "minutes": 0}
            genre_map[genre]["plays"] += doc.get("playCount", 0)
            genre_map[genre]["minutes"] += (doc.get("totalSeconds", 0) // 60)

        sorted_genres = sorted(genre_map.items(), key=lambda x: x[1]["minutes"], reverse=True)

        return {
            "top_genres": [
                {"genre": g[0], "plays": g[1]["plays"], "minutes": g[1]["minutes"]}
                for g in sorted_genres[:15]
            ],
            "unique_genres": len(genre_map)
        }
    
    @staticmethod
    async def get_top_songs(
        user_id: str,
        database,
        days: int = 30,
        limit: int = 10
    ) -> list:
        """Get top played songs."""
        cutoff_date = datetime.utcnow() - timedelta(days=days)

        pipeline = [
            {
                "$match": {
                    "userId": ObjectId(user_id),
                    "playedAt": {"$gte": cutoff_date}
                }
            },
            {
                "$group": {
                    "_id": "$song.videoId",
                    "playCount": {"$sum": 1},
                    "totalMinutes": {"$sum": {"$divide": ["$listenDuration", 60]}},
                    "title": {"$first": "$song.title"},
                    "artist": {"$first": "$song.artist"},
                    "thumbnail": {"$first": "$song.thumbnail"}
                }
            },
            {"$sort": {"playCount": -1}},
            {"$limit": limit}
        ]

        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
        top_songs = []
        async for doc in cursor:
            top_songs.append({
                "songId": doc["_id"],
                "title": doc.get("title"),
                "artist": doc.get("artist"),
                "plays": doc.get("playCount", 0),
                "totalMinutes": round(doc.get("totalMinutes", 0), 2),
                "coverUrl": doc.get("thumbnail")
            })

        return top_songs
    
    @staticmethod
    async def get_top_artists(
        user_id: str,
        database,
        days: int = 30,
        limit: int = 10
    ) -> list:
        """Get top artists by listening time."""
        cutoff_date = datetime.utcnow() - timedelta(days=days)

        pipeline = [
            {
                "$match": {
                    "userId": ObjectId(user_id),
                    "playedAt": {"$gte": cutoff_date}
                }
            },
            {
                "$group": {
                    "_id": {"$ifNull": ["$song.artist", "Unknown"]},
                    "totalSeconds": {"$sum": "$listenDuration"},
                    "playCount": {"$sum": 1}
                }
            }
        ]

        artist_map = {}
        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
        async for doc in cursor:
            artist = doc.get("_id") or "Unknown"
            if artist not in artist_map:
                artist_map[artist] = {"plays": 0, "minutes": 0}
            artist_map[artist]["plays"] += doc.get("playCount", 0)
            artist_map[artist]["minutes"] += (doc.get("totalSeconds", 0) // 60)

        sorted_artists = sorted(artist_map.items(), key=lambda x: x[1]["minutes"], reverse=True)

        return [
            {"artist": a[0], "plays": a[1]["plays"], "minutes": a[1]["minutes"]}
            for a in sorted_artists[:limit]
        ]
    
    @staticmethod
    async def get_discovery_rate(
        user_id: str,
        database,
        days: int = 30
    ) -> dict:
        """Calculate discovery rate (new songs vs repeats)."""
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        pipeline = [
            {
                "$match": {
                    "userId": ObjectId(user_id),
                    "playedAt": {"$gte": cutoff_date}
                }
            },
            {
                "$group": {
                    "_id": "$song.videoId",
                    "playCount": {"$sum": 1}
                }
            }
        ]
        
        cursor = database[db.PLAYBACK_HISTORIES].aggregate(pipeline)
        new_songs = 0
        repeat_plays = 0
        
        async for history in cursor:
            if not history.get("_id"):
                continue
            if history["playCount"] == 1:
                new_songs += 1
            else:
                repeat_plays += history["playCount"] - 1
        
        total_plays = new_songs + repeat_plays
        discovery_rate = (new_songs / total_plays * 100) if total_plays > 0 else 0
        
        return {
            "new_songs": new_songs,
            "repeat_plays": repeat_plays,
            "discovery_rate_percent": round(discovery_rate, 2),
            "total_plays": total_plays
        }


@router.get("/listening-time")
async def get_listening_time_stats(
    days: int = 30,
    current_user: dict = Depends(get_current_user)
):
    """Get listening time statistics for the past N days."""
    try:
        database = db.get_db()
        user_id = current_user["id"]
        
        stats = await StatisticsService.get_listening_time_stats(
            user_id,
            database,
            days
        )
        
        return {
            "success": True,
            "data": stats
        }
    except Exception as e:
        logger.error(f"Error getting listening time stats: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve listening time statistics."
        }


@router.get("/genres")
async def get_genre_stats(
    days: int = 30,
    current_user: dict = Depends(get_current_user)
):
    """Get genre breakdown of listening."""
    try:
        database = db.get_db()
        user_id = current_user["id"]
        
        stats = await StatisticsService.get_genre_stats(
            user_id,
            database,
            days
        )
        
        return {
            "success": True,
            "data": stats
        }
    except Exception as e:
        logger.error(f"Error getting genre stats: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve genre statistics."
        }


@router.get("/top-songs")
async def get_top_songs(
    days: int = 30,
    limit: int = 10,
    current_user: dict = Depends(get_current_user)
):
    """Get top played songs."""
    try:
        if limit > 50:
            limit = 50
        
        database = db.get_db()
        user_id = current_user["id"]
        
        songs = await StatisticsService.get_top_songs(
            user_id,
            database,
            days,
            limit
        )
        
        return {
            "success": True,
            "data": songs
        }
    except Exception as e:
        logger.error(f"Error getting top songs: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve top songs."
        }


@router.get("/top-artists")
async def get_top_artists(
    days: int = 30,
    limit: int = 10,
    current_user: dict = Depends(get_current_user)
):
    """Get top artists by listening time."""
    try:
        if limit > 50:
            limit = 50
        
        database = db.get_db()
        user_id = current_user["id"]
        
        artists = await StatisticsService.get_top_artists(
            user_id,
            database,
            days,
            limit
        )
        
        return {
            "success": True,
            "data": artists
        }
    except Exception as e:
        logger.error(f"Error getting top artists: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve top artists."
        }


@router.get("/discovery-rate")
async def get_discovery_rate(
    days: int = 30,
    current_user: dict = Depends(get_current_user)
):
    """Get discovery rate (new songs vs repeats)."""
    try:
        database = db.get_db()
        user_id = current_user["id"]
        
        stats = await StatisticsService.get_discovery_rate(
            user_id,
            database,
            days
        )
        
        return {
            "success": True,
            "data": stats
        }
    except Exception as e:
        logger.error(f"Error getting discovery rate: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve discovery rate statistics."
        }


@router.get("/global-leaderboard")
async def get_global_leaderboard():
    """Get the top 3 global listeners by total listening minutes (all time)."""
    try:
        database = db.get_db()
        pipeline = [
            {"$match": {"statistics.totalListeningTime": {"$gt": 0}}},
            {"$project": {
                "_id": 0,
                "displayName": {"$ifNull": ["$displayName", "Anonymous"]},
                "avatar": {"$ifNull": ["$avatar", None]},
                "avatarMediaId": 1,
                "totalMinutes": {"$divide": ["$statistics.totalListeningTime", 60]}
            }},
            {"$sort": {"totalMinutes": -1}},
            {"$limit": 3}
        ]
        cursor = database[db.USERS].aggregate(pipeline)
        leaders = []
        async for doc in cursor:
            await decorate_user_avatar(doc)
            leaders.append({
                "displayName": doc["displayName"],
                "avatar": doc.get("avatar"),
                "totalMinutes": int(doc["totalMinutes"])
            })
        return {"success": True, "data": leaders}
    except Exception as e:
        logger.error(f"Error getting global leaderboard: {str(e)}")
        return {"success": False, "error": "Failed to load global leaderboard."}


@router.get("/dashboard")
async def get_dashboard_stats(
    days: int = 30,
    current_user: dict = Depends(get_current_user)
):
    """Get all dashboard statistics in one call."""
    try:
        database = db.get_db()
        user_id = current_user["id"]
        
        # Fetch all stats in parallel (5x faster than sequential)
        import asyncio
        listening_time, genres, top_songs, top_artists, discovery = await asyncio.gather(
            StatisticsService.get_listening_time_stats(user_id, database, days),
            StatisticsService.get_genre_stats(user_id, database, days),
            StatisticsService.get_top_songs(user_id, database, days, 5),
            StatisticsService.get_top_artists(user_id, database, days, 5),
            StatisticsService.get_discovery_rate(user_id, database, days),
        )
        
        return {
            "success": True,
            "data": {
                "listening_time": listening_time,
                "genres": genres,
                "top_songs": top_songs,
                "top_artists": top_artists,
                "discovery": discovery,
                "period_days": days
            }
        }
    except Exception as e:
        logger.error(f"Error getting dashboard stats: {str(e)}")
        return {
            "success": False,
            "error": "Failed to retrieve dashboard statistics."
        }
