"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface LastPlayedPlaylist {
  id: string;
  name: string;
  coverUrl?: string;
  songCount: number;
}

interface LastPlayedPlaylistState {
  lastPlayed: LastPlayedPlaylist | null;
  recordPlayed: (playlist: LastPlayedPlaylist) => void;
  clear: () => void;
}

export const useLastPlayedPlaylistStore = create<LastPlayedPlaylistState>()(
  persist(
    (set) => ({
      lastPlayed: null,
      recordPlayed: (playlist) => set({ lastPlayed: playlist }),
      clear: () => set({ lastPlayed: null }),
    }),
    {
      name: "strumm-last-played-playlist",
      partialize: (state) => ({ lastPlayed: state.lastPlayed }),
    }
  )
);
