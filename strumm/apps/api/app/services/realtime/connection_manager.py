"""
Enhanced Connection Manager for WebSocket connections.

Supports two tiers:
  1. **User connections** — one WebSocket per authenticated user (global).
  2. **Room connections** — one WebSocket per user per room (room sync, WebRTC).

This separation keeps room voice/WebRTC signalling isolated from the
global event feed while allowing both to coexist on the same server.

Scalability note
----------------
In a single-server deployment all state lives in memory.  To scale
horizontally, replace the in-memory dicts with Redis Pub/Sub channels
(e.g. `user:{userId}` and `room:{roomId}`).  The interface stays the
same — swap the implementation behind the same class.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List, Optional, Set
from fastapi import WebSocket

from .events import PING, PONG, ERROR

logger = logging.getLogger("strumm-realtime")

# ---------------------------------------------------------------------------
# Singleton manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """
    Manages global user WebSocket connections and room-scoped connections.

    Global connections (``user_connections``) carry:
      - Presence updates (online / offline / listening)
      - Circle activity (friend started listening, etc.)
      - Notifications
      - Player state sync

    Room connections (``room_connections``) carry:
      - Track sync (play/pause/seek)
      - Collaborative queue
      - Chat messages
      - WebRTC signalling (voice)
    """

    def __init__(self) -> None:
        # userId -> list of (WebSocket, is_global)
        self._user_connections: Dict[str, List[WebSocket]] = {}
        # roomId -> list of (userId, WebSocket)
        self._room_connections: Dict[str, List[tuple[str, WebSocket]]] = {}
        # Reverse: websocket id -> set of subscribed event types (for filtering)
        self._subscriptions: Dict[int, Set[str]] = {}

    # ------------------------------------------------------------------
    # Global connection management
    # ------------------------------------------------------------------

    async def connect_user(self, user_id: str, websocket: WebSocket) -> None:
        """Register a global WebSocket for a user.
        
        Note: The caller is responsible for calling ``await websocket.accept()``
        before calling this function (e.g. after authentication).
        """
        if user_id not in self._user_connections:
            self._user_connections[user_id] = []
        self._user_connections[user_id].append(websocket)
        logger.info(
            "WS connect (global) — user=%s, total=%d",
            user_id[:8],
            len(self._user_connections[user_id]),
        )

    def disconnect_user(self, user_id: str, websocket: WebSocket) -> None:
        """Remove a global WebSocket for a user."""
        if user_id in self._user_connections:
            before = len(self._user_connections[user_id])
            self._user_connections[user_id] = [
                ws for ws in self._user_connections[user_id] if ws != websocket
            ]
            after = len(self._user_connections[user_id])
            if after == 0:
                del self._user_connections[user_id]
            logger.info(
                "WS disconnect (global) — user=%s, before=%d, after=%d",
                user_id[:8], before, after,
            )

    # ------------------------------------------------------------------
    # Room connection management
    # ------------------------------------------------------------------

    async def connect_room(self, room_id: str, user_id: str, websocket: WebSocket) -> None:
        """Register a room-scoped WebSocket.
        
        Note: The caller is responsible for calling ``await websocket.accept()``
        before calling this function (e.g. after authentication).
        """
        if room_id not in self._room_connections:
            self._room_connections[room_id] = []
        self._room_connections[room_id].append((user_id, websocket))
        logger.info(
            "WS connect (room) — room=%s, user=%s",
            room_id[:8], user_id[:8],
        )

    def disconnect_room(self, room_id: str, websocket: WebSocket) -> None:
        """Remove a room-scoped WebSocket."""
        if room_id in self._room_connections:
            self._room_connections[room_id] = [
                c for c in self._room_connections[room_id] if c[1] != websocket
            ]
            if not self._room_connections[room_id]:
                del self._room_connections[room_id]

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    async def send_json(self, websocket: WebSocket, message: dict) -> None:
        """Send a JSON message to a single WebSocket, handling errors gracefully."""
        try:
            await websocket.send_json(message)
        except Exception:
            pass

    async def send_to_user(self, user_id: str, message: dict) -> int:
        """
        Send a message to **all** global WebSocket connections for a user.

        Returns the number of connections the message was sent to.
        """
        connections = self._user_connections.get(user_id, [])
        sent = 0
        for ws in connections:
            await self.send_json(ws, message)
            sent += 1
        return sent

    async def broadcast_to_room(
        self,
        room_id: str,
        message: dict,
        exclude_user_id: Optional[str] = None,
    ) -> int:
        """
        Broadcast a message to all connections in a room.

        Returns the number of connections the message was sent to.
        """
        connections = self._room_connections.get(room_id, [])
        sent = 0
        for uid, ws in connections:
            if exclude_user_id is not None and uid == exclude_user_id:
                continue
            await self.send_json(ws, message)
            sent += 1
        return sent

    async def broadcast_to_circle(
        self,
        member_ids: List[str],
        message: dict,
        exclude_user_id: Optional[str] = None,
    ) -> int:
        """
        Broadcast a message to all global connections of a list of users
        (e.g. all circle members).
        """
        sent = 0
        for uid in member_ids:
            if exclude_user_id is not None and uid == exclude_user_id:
                continue
            sent += await self.send_to_user(uid, message)
        return sent

    async def broadcast_global(self, message: dict) -> int:
        """Broadcast to **every** connected user (use sparingly)."""
        sent = 0
        for connections in self._user_connections.values():
            for ws in connections:
                await self.send_json(ws, message)
                sent += 1
        return sent

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def user_online_count(self) -> int:
        return len(self._user_connections)

    def room_connection_count(self, room_id: str) -> int:
        return len(self._room_connections.get(room_id, []))

    def get_user_connections(self, user_id: str) -> List[WebSocket]:
        return self._user_connections.get(user_id, [])

    def is_user_online(self, user_id: str) -> bool:
        return user_id in self._user_connections and bool(self._user_connections[user_id])


# Global singleton — imported by routes and WebSocket handlers
manager = ConnectionManager()
