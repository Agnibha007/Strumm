"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";
import { EventDispatcher, WS_CONNECTED } from "web/services/realtime";

/**
 * PlayerStateSync — cross-device player state synchronisation.
 *
 * Unlike the previous implementation that:
 *   - Sent PUT /player-state on EVERY state change (debounced 900ms)
 *   - ALSO sent PUT /player-state every 10 seconds via setInterval
 *
 * This version:
 *   - Saves to the server only for SIGNIFICANT events (play, pause,
 *     track change, queue change, shuffle/repeat mode).
 *   - Does NOT poll or periodically re-save state.
 *   - Listens for cross-device sync events via WebSocket.
 *   - Still REST-ores state from the server on initial login.
 */
export default function PlayerStateSync() {
  const { user } = useAuthStore();
  const restoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    currentSong,
    queue,
    currentIndex,
    isPlaying,
    isShuffle,
    repeatMode,
    restorePlayerState,
  } = usePlayerStore();

  // -------------------------------------------------------------------
  // Initial restore: fetch saved state from server once
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!user || restoredRef.current) return;

    const restore = async () => {
      try {
        // Auth is handled via httpOnly cookie with credentials: 'include'
        const response = await fetch(apiUrl("/player-state"), {
          credentials: "include",
        });
        const json = await response.json();
        if (json.success && json.data?.currentSong) {
          restorePlayerState({
            currentSong: json.data.currentSong,
            queue: json.data.queue || [],
            currentIndex: json.data.currentIndex ?? -1,
            currentTime: json.data.currentTime ?? 0,
            volume: json.data.volume ?? 0.8,
            isShuffle: json.data.isShuffle ?? false,
            repeatMode: json.data.repeatMode ?? "none",
            playbackRate: json.data.playbackRate ?? 1,
          });
        }
      } catch {
        console.warn("Unable to restore cross-device player state.");
      } finally {
        restoredRef.current = true;
      }
    };

    restore();
  }, [user, restorePlayerState]);

  // -------------------------------------------------------------------
  // Save to server only on SIGNIFICANT events (debounced)
  // -------------------------------------------------------------------
  const saveState = useCallback(async () => {
    if (!user || !restoredRef.current) return;
    const state = usePlayerStore.getState();
    try {
      // Auth via httpOnly cookie with credentials: 'include'
      await fetch(apiUrl("/player-state"), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          deviceId: "primary",
          currentSong: state.currentSong,
          queue: state.queue,
          currentIndex: state.currentIndex,
          isPlaying: state.isPlaying,
          volume: state.volume,
          currentTime: state.currentTime,
          isShuffle: state.isShuffle,
          repeatMode: state.repeatMode,
          playbackRate: state.playbackRate,
        }),
      });
    } catch {
      console.warn("Unable to save cross-device player state.");
    }
  }, [user]);

  // Significant event keys — changes to these trigger a server save
  const significantKeys = [
    currentSong?.videoId,
    queue.length,
    currentIndex,
    isPlaying,
    isShuffle,
    repeatMode,
  ];

  useEffect(() => {
    if (!user || !restoredRef.current) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(saveState, 1200);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [user, ...significantKeys, saveState]);

  // -------------------------------------------------------------------
  // Re-save state when WebSocket reconnects (new device may have joined)
  // -------------------------------------------------------------------
  // Re-save state when WebSocket reconnects (new device may have joined)
  // -------------------------------------------------------------------
  useEffect(() => {
    const dispatch = EventDispatcher.getInstance();

    const unsub = dispatch.on(WS_CONNECTED, () => {
      if (restoredRef.current) {
        saveState();
      }
    });

    return unsub;
  }, [saveState]);

  return null;
}
