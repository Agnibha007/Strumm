/**
 * Realtime event type constants.
 *
 * These mirror the backend's event constants exactly so both sides
 * speak the same protocol. Every event follows:
 *   { "event": EVENT_TYPE, "data": { ... } }
 *
 * Never hardcode event name strings in components — always import
 * the constant from this file.
 */

// ---------------------------------------------------------------------------
// Player events
// ---------------------------------------------------------------------------

export const PLAYER_UPDATED = "player:updated";
export const TRACK_CHANGED = "player:track_changed";
export const PLAYER_PLAY = "player:play";
export const PLAYER_PAUSE = "player:pause";
export const PLAYER_SEEK = "player:seek";
export const PLAYER_QUEUE_UPDATED = "player:queue_updated";
export const PLAYER_SYNC = "player:sync";
export const PLAYER_STATE = "player:state";

// ---------------------------------------------------------------------------
// Presence events
// ---------------------------------------------------------------------------

export const USER_ONLINE = "presence:online";
export const USER_OFFLINE = "presence:offline";
export const USER_LISTENING = "presence:listening";
export const USER_NOT_LISTENING = "presence:not_listening";

// ---------------------------------------------------------------------------
// Social / Circle events
// ---------------------------------------------------------------------------

export const CIRCLE_ACTIVITY_UPDATED = "circle:activity_updated";
export const FRIEND_REQUEST = "circle:friend_request";
export const FRIEND_ACCEPTED = "circle:friend_accepted";
export const FRIEND_REMOVED = "circle:friend_removed";

// ---------------------------------------------------------------------------
// Room events
// ---------------------------------------------------------------------------

export const ROOM_CREATED = "room:created";
export const ROOM_UPDATED = "room:updated";
export const ROOM_DELETED = "room:deleted";
export const ROOM_JOINED = "room:joined";
export const ROOM_LEFT = "room:left";
export const ROOM_MEMBER_COUNT = "room:member_count";

// ---------------------------------------------------------------------------
// Notification events
// ---------------------------------------------------------------------------

export const NOTIFICATION_CREATED = "notification:created";

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export const PING = "ping";
export const PONG = "pong";
export const WS_ERROR = "error";
export const WS_CONNECTED = "connected";
export const WS_DISCONNECTED = "disconnected";
export const WS_RECONNECTING = "reconnecting";

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface PresenceData {
  id: string;
  displayName: string;
  username: string;
  avatar?: string;
  song?: {
    videoId: string;
    title: string;
    artist: string;
    thumbnail: string;
  };
  timestamp?: string;
}

export interface PlayerSyncData {
  currentSong?: any;
  queue?: any[];
  currentIndex?: number;
  isPlaying?: boolean;
  currentTime?: number;
  volume?: number;
  isShuffle?: boolean;
  repeatMode?: string;
  playbackRate?: number;
}

export interface RoomEventData {
  roomId: string;
  userId?: string;
  name?: string;
  memberCount?: number;
}

export interface WsEvent {
  event: string;
  data: any;
}
