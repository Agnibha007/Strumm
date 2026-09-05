"""Canonical user serialization.

Safe-by-construction allowlist: only fields the frontend (``@strumm/types``
``User``) and public profiles consume may be emitted. Credential fields such as
``password`` / ``passwordHash`` can never appear in an API payload regardless of
which Mongo document flavor a caller passes in — there is no blacklist path.

Use this everywhere a user document is returned to a client.
"""

from datetime import datetime
from typing import Any, Dict, Optional


# Fields the client layer is allowed to see. Mirrors the frontend User type plus
# the server-derived fields (soundDNA, statistics, badges, avatar*).
SAFE_USER_FIELDS: frozenset[str] = frozenset({
    "id",
    "email",
    "username",
    "displayName",
    "avatar",
    "avatarMediaId",
    "avatarExpiresIn",
    "bio",
    "role",
    "providers",
    "theme",
    "customThemeImage",
    "customImage",
    "createdAt",
    "settings",
    "statistics",
    "soundDNA",
    "badges",
})

# Known credential/internal field spellings. These are never emitted even if
# some future refactor adds a similar key to a user document.
NEVER_FIELDS: frozenset[str] = frozenset({
    "password",
    "passwordHash",
    "password_hash",
    "refreshTokenHash",
    "refresh_token_hash",
    "otps",
})


def serialize_user(user: Dict[str, Any], *, has_object_id: bool = False) -> Dict[str, Any]:
    """Return a safe, JSON-serializable user dict using an explicit allowlist.

    ``has_object_id`` maps a Mongo ``_id`` (ObjectId) to the string ``id`` field
    when the caller did not already add one. Any field not on the allowlist — or
    matching a known credential field — is dropped.
    """
    if not isinstance(user, dict):
        return {}

    out: Dict[str, Any] = {}
    for field in SAFE_USER_FIELDS:
        if field not in user:
            continue
        if field in NEVER_FIELDS:
            continue
        out[field] = user[field]

    if "id" not in out and has_object_id and user.get("_id") is not None:
        out["id"] = str(user["_id"])

    created = out.get("createdAt")
    if isinstance(created, datetime):
        out["createdAt"] = created.isoformat()
    return out