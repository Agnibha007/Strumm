"use client";

import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { WebSocketClient } from "./WebSocketClient";
import { EventDispatcher } from "./EventDispatcher";
import {
  USER_LISTENING,
  USER_NOT_LISTENING,
} from "./types";

/**
 * RealTimeProvider — mounts once inside the auth-guarded layout.
 *
 * Responsibilities:
 *   - Connects the WebSocket when the user logs in
 *   - Disconnects when the user logs out
 *   - Sends presence updates when the player starts/stops playing
 *   - Bridges cross-device player state sync (with debounce batching)
 *
 * Place this inside the AuthWrapper so it has access to the token.
 */
export default function RealTimeProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();

  const wsClient = WebSocketClient.getInstance();
  const dispatch = EventDispatcher.getInstance();
  const prevIsPlaying = useRef(false);
  const prevSongId = useRef<string | null>(null);
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the most recent remote (cross-device) player-state apply.
  // Anything we send within this window is just an echo of a remote change —
  // forwarding it back would bounce state around the user's other devices.
  const lastRemoteApplyAtRef = useRef(0);
  // Tracks the player position so a manual seek (its currentTime jumps) can be
  // forwarded even though the song itself never changed.
  const lastSyncedTimeRef = useRef(0);
  const lastSyncedSongIdRef = useRef<string | null>(null);
  // Skips the very first sync broadcast on mount — a freshly-mounted device
  // (with a restored-but-paused player) must not pause the user's other
  // listening devices by announcing its idle state.
  const initializedRef = useRef(false);

  // ---- Connect / disconnect on auth state change ----
  useEffect(() => {
    if (user && token) {
      wsClient.connect(token);
    } else {
      wsClient.disconnect();
      dispatch.reset();
    }

    return () => {
      // Don't disconnect on unmount — keep alive across navigations
    };
  }, [user, token, wsClient, dispatch]);

  // ---- Presence: send listening state when player changes ----
  const sendListeningState = useCallback(() => {
    const state = usePlayerStore.getState();
    const currentSong = state.currentSong;
    const isPlaying = state.isPlaying;

    if (isPlaying && currentSong) {
      wsClient.send(USER_LISTENING, {
        song: {
          videoId: currentSong.videoId,
          title: currentSong.title,
          artist: currentSong.artist,
          thumbnail: currentSong.thumbnail,
        },
      });
    } else {
      wsClient.send(USER_NOT_LISTENING);
    }
  }, [wsClient]);

  useEffect(() => {
    if (presenceTimer.current) clearTimeout(presenceTimer.current);

    presenceTimer.current = setTimeout(() => {
      const state = usePlayerStore.getState();
      const currentSong = state.currentSong;
      const isPlaying = state.isPlaying;
      const songId = currentSong?.videoId ?? null;

      const playingChanged = isPlaying !== prevIsPlaying.current;
      const songChanged = songId !== prevSongId.current;

      if (playingChanged || songChanged) {
        sendListeningState();
        prevIsPlaying.current = isPlaying;
        prevSongId.current = songId;
      }
    }, 500);

    return () => {
      if (presenceTimer.current) clearTimeout(presenceTimer.current);
    };
  }, [
    usePlayerStore((s) => s.currentSong?.videoId),
    usePlayerStore((s) => s.isPlaying),
    sendListeningState,
  ]);

  // ---- Listen for cross-device player sync ----
  useEffect(() => {
    const unsub = dispatch.on("player:state", (data) => {
      const store = usePlayerStore.getState();
      store.applyRemoteState(data);
      lastRemoteApplyAtRef.current = Date.now();
    });

    return unsub;
  }, [dispatch]);

  // ---- Send player sync to other devices (debounced / batched) ----
  // Uses a 400ms debounce so rapid play/pause/seek events are consolidated
  // into a single message.
  const isRecentlyRemoteApplied = () =>
    Date.now() - lastRemoteApplyAtRef.current < 600;

  const sendPlayerSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);

    syncTimer.current = setTimeout(() => {
      if (!user) return;
      const state = usePlayerStore.getState();
      wsClient.send("player:sync", {
        currentSong: state.currentSong,
        queue: state.queue,
        currentIndex: state.currentIndex,
        isPlaying: state.isPlaying,
        currentTime: state.currentTime,
        volume: state.volume,
        isShuffle: state.isShuffle,
        repeatMode: state.repeatMode,
        playbackRate: state.playbackRate,
      });
    }, 400);
  }, [user, token, wsClient]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    if (isRecentlyRemoteApplied()) return;
    sendPlayerSync();
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [
    usePlayerStore((s) => s.currentSong?.videoId),
    usePlayerStore((s) => s.isPlaying),
    usePlayerStore((s) => s.queue.length),
    usePlayerStore((s) => s.currentIndex),
    usePlayerStore((s) => s.repeatMode),
    usePlayerStore((s) => s.isShuffle),
    sendPlayerSync,
  ]);

  // Forward manual seeks: playback position normally advances smoothly, but a
  // user scrub makes currentTime jump. Detect the jump and push the new
  // position so cross-device listeners snap to the same place.
  useEffect(() => {
    const state = usePlayerStore.getState();
    const t = state.currentTime;
    const songId = state.currentSong?.videoId ?? null;

    if (songId !== lastSyncedSongIdRef.current) {
      lastSyncedSongIdRef.current = songId;
      lastSyncedTimeRef.current = t;
      return;
    }

    const jumped = Math.abs(t - lastSyncedTimeRef.current) > 3;
    lastSyncedTimeRef.current = t;
    if (jumped && !isRecentlyRemoteApplied()) {
      sendPlayerSync();
    }
  }, [usePlayerStore((s) => s.currentTime), sendPlayerSync]);

  return <>{children}</>;
}
