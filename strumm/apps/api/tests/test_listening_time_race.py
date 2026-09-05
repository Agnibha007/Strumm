"""
Simulation of the listening-time race fix, exercising the real
reconcile_listening_time_and_save implementation.

/play-event atomically $inc's statistics.totalListeningTime.  The debounced
background recalc previously did a blind $set from a snapshot of histories,
which could clobber a newer $inc (listening time stalls/regresses).

The fix replaces the $set with a monotonic compare-and-swap reconcile:
  * never writes the counter backwards (only $inc the shortfall);
  * CAS filter on the read value so we never double-count a concurrent $inc.
"""

import asyncio
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, "app")
from app.routes.user import reconcile_listening_time_and_save

USERS = "users"


class FakeCollection:
    """users collection with real $inc / $set semantics and a CAS filter."""

    def __init__(self):
        self.doc = {"_id": "U1", "statistics": {"totalListeningTime": 0}}
        self.calls = []

    def current(self):
        return self.doc["statistics"]["totalListeningTime"]

    async def update_one(self, filt, update):
        self.calls.append((dict(filt), update))
        if "statistics.totalListeningTime" in filt:
            if filt["statistics.totalListeningTime"] != self.current():
                return MagicMock(modified_count=0)
        for op_key in ("$inc", "$set"):
            op = update.get(op_key, {})
            for path, val in op.items():
                parts = path.split(".")
                node = self.doc
                for p in parts[:-1]:
                    node = node.setdefault(p, {})
                if op_key == "$inc":
                    node[parts[-1]] = node.get(parts[-1], 0) + val
                else:
                    node[parts[-1]] = val
        return MagicMock(modified_count=1)


def build_db():
    users = FakeCollection()
    db = MagicMock()
    db.USERS = USERS
    db.__getitem__.return_value = users
    return db, users


def make_stats(total):
    return {
        "soundDNA": {"energy": 5},
        "totalListeningTime": total,
        "monthlyListeningTime": total,
        "topArtists": [],
        "topSongs": [],
    }


async def run_regression_scenario():
    """Old bug: a stale recalc (read stored=60, history=60) must not clobber a
    newer $inc that landed while the recalc was in flight (counter -> 90)."""
    db, users = build_db()
    with patch("app.routes.user.db.get_db", return_value=db):
        # Play events A + B: counter -> 60.
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})

        # Recalc reads stored=60, history snapshot=60 (both A and B).
        stored_at_read, history_stale = 60, 60

        # A concurrent play event C lands while recalc is in flight:
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})

        # Stale recalc applies reconcile with its stale read (60) + stale history
        # (60) — must NOT write the counter down to 60; it must stay at 90.
        await reconcile_listening_time_and_save(
            "U1", make_stats(history_stale), {"totalListeningTime": stored_at_read}
        )
        return users.current()


async def run_monotonic_topup():
    """Shortfall from missed/legacy increments is filled, never regressed."""
    db, users = build_db()
    with patch("app.routes.user.db.get_db", return_value=db):
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})
        # history proves the true total should be 90 (two missed events)
        await reconcile_listening_time_and_save("U1", make_stats(90), {"totalListeningTime": 30})
        return users.current()


async def run_no_double_count():
    """CAS prevents double-count when a concurrent $inc lands after the read."""
    db, users = build_db()
    with patch("app.routes.user.db.get_db", return_value=db):
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})
        stored = users.current()  # recalc reads 30
        # concurrent play_event lands while recalc computes:
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 30}})
        # recalc tries to top up to 60 with its stale read (30); CAS fails
        await reconcile_listening_time_and_save("U1", make_stats(60), {"totalListeningTime": stored})
        return users.current()


async def run_reset_history():
    """After DELETE /history resets the counter to 0, recalc respects it
    (no regression back up) once histories are cleared."""
    db, users = build_db()
    with patch("app.routes.user.db.get_db", return_value=db):
        await users.update_one({"_id": "U1"}, {"$inc": {"statistics.totalListeningTime": 90}})
        # User clears history; counter deliberately reset to 0.
        await users.update_one({"_id": "U1"}, {"$set": {"statistics.totalListeningTime": 0}})
        # Recalc sees empty history => total 0 => no top-up, stays 0.
        await reconcile_listening_time_and_save("U1", make_stats(0), {"totalListeningTime": 0})
        return users.current()


def test_no_regression():
    assert asyncio.run(run_regression_scenario()) == 90


def test_monotonic_topup():
    assert asyncio.run(run_monotonic_topup()) == 90


def test_no_double_count():
    assert asyncio.run(run_no_double_count()) == 60


def test_reset_history_respected():
    assert asyncio.run(run_reset_history()) == 0
