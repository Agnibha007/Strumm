"""Per-user daily download quotas for offline audio exports."""

from datetime import datetime

from pymongo import ReturnDocument

from app.database import mongodb as db

# A user may download at most this many songs per day (server-side MP3 exports).
DOWNLOAD_DAILY_SONG_LIMIT = 100

# A user may export at most this many playlists per day (CSV export).
DOWNLOAD_DAILY_PLAYLIST_EXPORT_LIMIT = 1


def _quota_date() -> str:
    return datetime.utcnow().date().isoformat()


async def _get_quota_doc(user_id: str) -> dict:
    database = db.get_db()
    doc = await database[db.DOWNLOAD_QUOTA].find_one({"userId": user_id, "date": _quota_date()})
    if not doc:
        doc = {"userId": user_id, "date": _quota_date(), "songDownloads": 0, "playlistExports": 0}
        await database[db.DOWNLOAD_QUOTA].insert_one(doc)
    return doc


async def try_consume_song_download(user_id: str) -> bool:
    """Atomically consume one song download from the user's daily quota.

    Returns ``True`` when the download is allowed (and the counter incremented),
    ``False`` when the user has already exhausted their daily song-download
    allowance (the caller should surface a quota error instead of downloading).
    """
    database = db.get_db()
    doc = await database[db.DOWNLOAD_QUOTA].find_one_and_update(
        {"userId": user_id, "date": _quota_date()},
        {"$inc": {"songDownloads": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    current = int(doc.get("songDownloads") or 0) if doc else 0
    if current > DOWNLOAD_DAILY_SONG_LIMIT:
        await database[db.DOWNLOAD_QUOTA].update_one(
            {"userId": user_id, "date": _quota_date()},
            {"$inc": {"songDownloads": -1}},
        )
        return False
    return True


async def try_consume_playlist_export(user_id: str) -> bool:
    """Atomically consume one playlist CSV export from the user's daily quota."""
    database = db.get_db()
    doc = await database[db.DOWNLOAD_QUOTA].find_one_and_update(
        {"userId": user_id, "date": _quota_date()},
        {"$inc": {"playlistExports": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    current = int(doc.get("playlistExports") or 0) if doc else 0
    if current > DOWNLOAD_DAILY_PLAYLIST_EXPORT_LIMIT:
        await database[db.DOWNLOAD_QUOTA].update_one(
            {"userId": user_id, "date": _quota_date()},
            {"$inc": {"playlistExports": -1}},
        )
        return False
    return True
