"""Per-user daily quota for playlist CSV exports."""

from datetime import datetime

from pymongo import ReturnDocument

from app.database import mongodb as db

PLAYLIST_EXPORT_DAILY_LIMIT = 1


def _quota_date() -> str:
    return datetime.utcnow().date().isoformat()


async def try_consume_playlist_export(user_id: str) -> bool:
    database = db.get_db()
    doc = await database[db.PLAYLIST_EXPORT_QUOTA].find_one_and_update(
        {"userId": user_id, "date": _quota_date()},
        {"$inc": {"playlistExports": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    current = int(doc.get("playlistExports") or 0) if doc else 0
    if current > PLAYLIST_EXPORT_DAILY_LIMIT:
        await database[db.PLAYLIST_EXPORT_QUOTA].update_one(
            {"userId": user_id, "date": _quota_date()},
            {"$inc": {"playlistExports": -1}},
        )
        return False
    return True
