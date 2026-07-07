"""
Realtime event type constants.

Every event follows the shape:
    {"event": "<EVENT_TYPE>", "data": { ... }}

Events prefixed with `user:` are sent to a single user.
Events prefixed with `circle:` are broadcast to all of a user's circle members.
Events prefixed with `room:` are broadcast to all members of a room.
"""

# ---------------------------------------------------------------------------
# Player events
# ---------------------------------------------------------------------------

PLAYER_UPDATED = "player:updated"        # Full player state snapshot
TRACK_CHANGED = "player:track_changed"   # A new track started playing
PLAYER_PLAY = "player:play"              # Playback resumed
PLAYER_PAUSE = "player:pause"            # Playback paused
PLAYER_SEEK = "player:seek"              # Seek to a new position
PLAYER_QUEUE_UPDATED = "player:queue_updated"

# ---------------------------------------------------------------------------
# Presence events
# ---------------------------------------------------------------------------

USER_ONLINE = "presence:online"
USER_OFFLINE = "presence:offline"
USER_LISTENING = "presence:listening"     # Started listening to a track
USER_NOT_LISTENING = "presence:not_listening"

# ---------------------------------------------------------------------------
# Social / Circle events
# ---------------------------------------------------------------------------

CIRCLE_ACTIVITY_UPDATED = "circle:activity_updated"  # Friend's activity changed
FRIEND_REQUEST = "circle:friend_request"
FRIEND_ACCEPTED = "circle:friend_accepted"
FRIEND_REMOVED = "circle:friend_removed"

# ---------------------------------------------------------------------------
# Room events
# ---------------------------------------------------------------------------

ROOM_CREATED = "room:created"
ROOM_UPDATED = "room:updated"
ROOM_DELETED = "room:deleted"
ROOM_JOINED = "room:joined"
ROOM_LEFT = "room:left"
ROOM_MEMBER_COUNT = "room:member_count"

# ---------------------------------------------------------------------------
# Notification events
# ---------------------------------------------------------------------------

NOTIFICATION_CREATED = "notification:created"

# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------

PING = "ping"
PONG = "pong"
ERROR = "error"
RECONNECT = "reconnect"
AUTHENTICATE = "authenticate"        # First message: carry JWT token
