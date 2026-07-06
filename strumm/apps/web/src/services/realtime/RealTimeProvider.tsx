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
      if (data.currentSong && data.currentSong.videoId !== store.currentSong?.videoId) {
        store.restorePlayerState(data);
      }
    });

    return unsub;
  }, [dispatch]);

  // ---- Send player sync to other devices (debounced / batched) ----
  // Uses a 400ms debounce so rapid play/pause/seek events are consolidated
  // into a single message.
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

  return <>{children}</>;
}
