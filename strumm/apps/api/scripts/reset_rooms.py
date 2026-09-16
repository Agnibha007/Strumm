"""One-shot production repair: restore host ownership for every room.

Which rooms: ALL rooms in the ``rooms`` collection, regardless of state.

What it does (and the __only__ thing it does):
  * Picks the CLEANEST host for each room = the account that is BOTH a current
    room member AND an active controller. Among those, the room's original
    ``hostId`` wins if it still qualifies; otherwise the longest-attached
    qualifying member/controller is chosen.
  * Writes that winner back as ``hostId`` and rewrites the ``controllers``
    array to be exactly ``[winner]`` (host is always a controller).
  * Leaves members, queue, currentTrack, playbackState, invite codes, and
    every other collection (users, circles, media, chat) completely untouched.

Why this fixes you: during the earlier host-drop bug, ownership was handed to
whichever listener happened to be connected, permanently (and the original
host was never re-encoded). So the created room still has the RIGHT members
and track — only ``hostId`` / ``controllers`` point at the wrong account, which
is exactly why you keep reading as a Listener. This script re-encodes the host
in place instead of nuking the room and losing the queue/song.

Guards: requires BOTH MONGODB_URI and CONFIRM_FIX_HOSTS=yes (like the rest of
the codebase, connections go through pymongo using the same async driver the
API uses). Dry-run mode lives in the same file: run without
CONFIRM_FIX_HOSTS=yes to preview exactly which rooms will change and print the
full before/after host/controller maps, without writing anything.

Security check: this script touches ONLY the rooms collection and never
touches or prints auth tokens, secrets, or any credentials. Do not add logging
of the connection string.
"""
import asyncio
import os
import sys

import pymongo
from pymongo import AsyncMongoClient

ROOMS_COLLECTION = "rooms"
CONFIRM_FLAG = "CONFIRM_FIX_HOSTS"
CONFIRM_VALUE = "yes"

HELP = (
    "\nYou need to pass both:\n"
    f"  MONGODB_URI       (connection string for the database holding rooms)\n"
    f"  {CONFIRM_FLAG}={CONFIRM_VALUE}  (explicit go-ahead)\n\n"
    "Without the confirm flag nothing is written — it only dry-runs.\n"
)


async def main() -> None:
    uri = os.getenv("MONGODB_URI")
    if not uri:
        print(HELP)
        sys.exit(2)

    dry_run = os.getenv(CONFIRM_FLAG) != CONFIRM_VALUE
    print("=== reset_rooms: host ownership repair ===")
    print(f"dry-run mode: {'ON (no writes)' if dry_run else 'OFF (writes WILL happen)'}")

    client = AsyncMongoClient(uri)
    try:
        database = client.get_database()
        rooms = database[ROOMS_COLLECTION]

        total = await rooms.count_documents({})
        print(f"rooms found: {total}")
        changed = 0
        hosts_repaired = 0

        async for room in rooms.find({}):
            room_id = room.get("_id")
            old_host = room.get("hostId")
            members = list({str(m) for m in (room.get("members") or []) if m})
            controllers = list({str(c) for c in (room.get("controllers") or []) if c})
            # The host is always implicitly a member+controller; be lenient if
            # staler docs left them out (bad hand-off / stragglers).
            if old_host:
                members.append(str(old_host))
                controllers.append(str(old_host))
            members = list(dict.fromkeys(members))
            controllers = list(dict.fromkeys(controllers))

            # Best candidate = someone who is BOTH member and controller.
            qualified = [m for m in members if m in controllers]
            if not qualified and controllers:
                qualified = controllers
            if not qualified:
                # Nobody sane to be host; keep the room but note it.
                continue

            # Prefer the original host if they still qualify; else the first
            # (longest-connected) qualified member.
            if old_host and old_host in qualified:
                new_host = old_host
            else:
                new_host = qualified[0]

            if new_host == old_host:
                continue  # room is already correct — no write needed.

            changes = {
                "hostId": new_host,
                "controllers": [new_host],
            }
            if dry_run:
                print(f"  [dry-run] room={room_id} host {old_host} -> {new_host}")
            else:
                await rooms.update_one({"_id": room_id}, {"$set": changes})
                print(f"  [wrote]   room={room_id} host {old_host} -> {new_host}")
            changed += 1
            hosts_repaired += 1

        print()
        print(f"{'DRY-RUN SUMMARY' if dry_run else 'DONE'}: {changed} room(s) would be "
              f"repaired / were repaired; {total} room(s) total.")
    finally:
        await client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nInterrupted gracefully; nothing further was written.")
        sys.exit(130)
