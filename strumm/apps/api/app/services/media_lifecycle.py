"""
Unused-media lifecycle for the B2 object store.

B2 lifecycle rules cannot express "unused for N days" — they only look at object
*age*. So expiry is enforced at the application layer: every time the backend
authorizes a download of a media object it bumps ``lastAccessedAt``, and a
periodic job in this module soft-deletes objects whose ``lastAccessedAt`` is
older than ``MEDIA_UNUSED_RETENTION_DAYS``.

Guarantees
----------
* **Not age-based** — only objects last *accessed* more than the retention
  window ago are candidates. Uploading a file and never opening it expires it;
  opening a file keeps it alive indefinitely.
* **Referenced media is never deleted.** A user whose ``users.avatarMediaId``
  points at a record shields it from expiry, even when it looks stale. Live
  access (a freshly issued download/avatar URL) also shields it.
* **Concurrency-safe across replicas.** Each candidate is *claimed* with an
  atomic ``update_one`` (``cleanupClaimedUntil`` timestamp) before any B2
  mutation, so two workers can never both delete the same object. Stale claims
  are reclaimed after ``CLEANUP_CLAIM_TTL``.
* **Idempotent.** Every step is safe to rerun: B2 ``DELETE`` of a missing
  object succeeds, and if the record finalize fails the work is simply
  reattempted next pass. A failure *between* B2 delete and record finalize
  leaves the record claim-free and stale, so the next pass finishes the job.

B2 versioning ("Keep all versions")
-----------------------------------
The bucket keeps all versions, so a B2 ``DELETE`` only creates a *delete
marker*: the object is hidden (reads 404) but any previous versions remain and
still consume storage. The cleanup therefore treats deletion as "hidden from
the application", not "storage reclaimed". Purge of old versions is a separate
bucket-level concern and must not be conflated with the app's unused-expiry
decision:

* Reclaiming historical versions safely is a B2 lifecycle-rule job (e.g. an
  "abort incomplete multipart" + "delete previous versions after N days" rule
  scoped to the bucket). It is age-based by design and only ever removes
  *old versions of objects the app has already hidden* — it can never expose a
  deleted file because the delete marker stays as the current version.
* Do NOT use an object-age lifecycle rule as the expiry mechanism for the
  *current* version: that would delete actively referenced media (e.g. a user's
  avatar that has not been re-uploaded for 5 days). Unused expiry must stay at
  the application layer via ``lastAccessedAt`` (this module).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta

from app.database import mongodb as db
from app.services import storage

logger = logging.getLogger("strumm-media-lifecycle")

# --- Configuration ----------------------------------------------------------

# How many *consecutive days without access* before an unused media record is
# eligible for expiry. Environment-tunable so ops can extend retention without
# a code change; defaults to 5 days.
MEDIA_UNUSED_RETENTION_DAYS = max(1, int(os.getenv("MEDIA_UNUSED_RETENTION_DAYS", "5")))

# How often the cleanup job runs (seconds). Poll-only; keeps replica churn low.
MEDIA_CLEANUP_INTERVAL_SECONDS = max(300, int(os.getenv("MEDIA_CLEANUP_INTERVAL_SECONDS", "3600")))

# Set to "0" to disable the in-process cleanup job entirely (e.g. when a
# separate cron/worker owns cleanup).
MEDIA_CLEANUP_ENABLED = os.getenv("MEDIA_CLEANUP_ENABLED", "1").strip().lower() not in ("0", "false", "no")

# How long a claim lives before another worker may take over the same record.
CLEANUP_CLAIM_TTL = timedelta(minutes=30)


# --- Access tracking --------------------------------------------------------

async def mark_media_accessed(database, record) -> None:
    """Record that a media object was authorized for reading/downloading.

    Called at the download-authorization boundary (issuing a presigned GET
    URL), never for metadata operations such as upload *confirm*. Failed
    writes are logged and ignored: the update is best-effort and only ever
    keeps media alive, never deletes anything.
    """
    if not record:
        return
    try:
        await database[db.MEDIA].update_one(
            {"_id": record["_id"], "deletedAt": None},
            {"$set": {"lastAccessedAt": datetime.utcnow()}},
        )
    except Exception as exc:
        logger.warning(f"media lifecycle: failed to update lastAccessedAt media={record.get('_id')}: {exc!s:.160}")


# --- Cleanup job ------------------------------------------------------------

async def _is_referenced(database, media_id) -> bool:
    """True when the record is still referenced by application data.

    Today the only reference is ``users.avatarMediaId`` pointing at the media
    record's hex ``_id``. Extend this if new collections start referencing
    media.
    """
    media_id_hex = str(media_id)
    try:
        referenced = await database[db.USERS].find_one(
            {"avatarMediaId": media_id_hex},
            {"_id": 1},
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"media lifecycle: reference check failed media={media_id_hex}: {exc!s:.160}")
        return True  # when in doubt, keep the media
    return referenced is not None


async def _release_claim(database, media_id) -> None:
    try:
        await database[db.MEDIA].update_one(
            {"_id": media_id},
            {"$unset": {"cleanupClaimedUntil": 1, "cleanupClaimedAt": 1}},
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(f"media lifecycle: failed to release claim media={media_id}: {exc!s:.160}")


async def cleanup_expired_media(database=None) -> dict:
    """Delete B2 objects (and soft-delete their records) last accessed longer
    than ``MEDIA_UNUSED_RETENTION_DAYS`` ago. Returns a stats dict.

    Safe to call from any number of concurrent processes.
    """
    database = database or db.get_db()
    stats = {"scanned": 0, "eligible": 0, "referenced": 0, "deleted": 0, "skipped": 0, "errors": 0}

    if not storage.storage_enabled():
        logger.info("Media cleanup skipped: object storage is not configured.")
        stats["skipped"] += 1
        return stats

    now = datetime.utcnow()
    cutoff = now - timedelta(days=MEDIA_UNUSED_RETENTION_DAYS)
    claim_until = now + CLEANUP_CLAIM_TTL

    # Candidate: not deleted, and either (a) accessed before the cutoff, or
    # (b) entirely untracked (legacy records) whose creation predates it.
    query = {
        "deletedAt": None,
        "$or": [
            {"lastAccessedAt": {"$lt": cutoff}},
            {"lastAccessedAt": {"$exists": False}, "createdAt": {"$lt": cutoff}},
        ],
    }

    try:
        cursor = database[db.MEDIA].find(query)
    except Exception as exc:  # pragma: no cover - defensive
        logger.error(f"media cleanup query failed: {exc!s:.200}")
        stats["errors"] += 1
        return stats

    async for record in cursor:
        media_id = record["_id"]
        stats["scanned"] += 1
        stats["eligible"] += 1

        # Atomic claim: only one worker may own this record at a time. Stale
        # claims (crashed worker) from longer than the TTL ago are re-claimed.
        claimed = await database[db.MEDIA].update_one(
            {
                "_id": media_id,
                "deletedAt": None,
                "$or": [
                    {"cleanupClaimedUntil": {"$exists": False}},
                    {"cleanupClaimedUntil": {"$lt": now}},
                ],
            },
            {
                "$set": {
                    "cleanupClaimedUntil": claim_until,
                    "cleanupClaimedAt": now,
                }
            },
        )
        if claimed.modified_count == 0:
            stats["skipped"] += 1
            continue

        try:
            # Re-read under the claim to avoid acting on a stale snapshot.
            fresh = await database[db.MEDIA].find_one({"_id": media_id, "deletedAt": None})
            if not fresh:
                stats["skipped"] += 1
                continue

            # Reference guard: a user currently using this media shields it.
            if await _is_referenced(database, media_id):
                stats["referenced"] += 1
                await _release_claim(database, media_id)
                continue

            # B2 delete first. Idempotent: deleting an already-missing object
            # is a success, so a failed finalize below self-heals next pass.
            # (delete_object is a synchronous storage call.)
            storage.delete_object(fresh["objectKey"])

            finalized = await database[db.MEDIA].update_one(
                {"_id": media_id, "cleanupClaimedUntil": claim_until},
                {
                    "$set": {
                        "status": "deleted",
                        "deletedAt": datetime.utcnow(),
                        "updatedAt": datetime.utcnow(),
                    },
                    "$unset": {"cleanupClaimedUntil": 1, "cleanupClaimedAt": 1},
                },
            )
            if finalized.modified_count:
                stats["deleted"] += 1
            else:  # pragma: no cover - defensive
                stats["skipped"] += 1
        except Exception as exc:
            stats["errors"] += 1
            logger.error(f"media cleanup failed media={media_id}: {exc!s:.200}")
            await _release_claim(database, media_id)

    logger.info(f"Media cleanup pass complete: {stats}")
    return stats


async def run_media_cleanup_loop() -> None:
    """Periodic in-process cleanup loop. One per process; claim-based locking
    makes concurrent replicas safe. Cancelled during app shutdown."""
    if not MEDIA_CLEANUP_ENABLED:
        logger.info("Media cleanup job is disabled via MEDIA_CLEANUP_ENABLED.")
        return
    # Let startup settle before the first pass.
    await asyncio.sleep(2)
    while True:
        started = time.monotonic()
        try:
            await cleanup_expired_media()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.error(f"media cleanup pass raised: {exc!s:.200}")
        elapsed = time.monotonic() - started
        await asyncio.sleep(max(MEDIA_CLEANUP_INTERVAL_SECONDS - elapsed, 1))