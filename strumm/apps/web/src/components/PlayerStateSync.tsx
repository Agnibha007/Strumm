"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";

export default function PlayerStateSync() {
  const { token } = useAuthStore();
  const restoredRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const {
    currentSong,
    queue,
    currentIndex,
    isPlaying,
    volume,
    currentTime,
    isShuffle,
    repeatMode,
    playbackRate,
    restorePlayerState,
  } = usePlayerStore();

  const saveState = useCallback(async () => {
    if (!token || !restoredRef.current) return;
    const state = usePlayerStore.getState();
    try {
      await fetch(apiUrl("/player-state"), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
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
    } catch (e) {
      console.warn("Unable to save cross-device player state.");
    }
  }, [token]);

  useEffect(() => {
    if (!token || restoredRef.current) return;

    const restore = async () => {
      try {
        const response = await fetch(apiUrl("/player-state"), {
          headers: { "Authorization": `Bearer ${token}` },
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
      } catch (e) {
        console.warn("Unable to restore cross-device player state.");
      } finally {
        restoredRef.current = true;
      }
    };

    restore();
  }, [token, restorePlayerState]);

  useEffect(() => {
    if (!token || !restoredRef.current) return;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(saveState, 900);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    token,
    currentSong,
    queue,
    currentIndex,
    isPlaying,
    volume,
    isShuffle,
    repeatMode,
    playbackRate,
    saveState,
  ]);

  useEffect(() => {
    if (!token) return;
    const interval = window.setInterval(() => {
      if (usePlayerStore.getState().currentSong) {
        saveState();
      }
    }, 10000);
    return () => window.clearInterval(interval);
  }, [token, saveState]);

  return null;
}
