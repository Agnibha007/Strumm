/**
 * Radio mode actions extracted from usePlayerStore.
 *
 * These helpers wrap the radio start/stop/fetch logic so the main store file
 * can stay lean.  Each factory receives `set` and `get` from the store.
 */
import { Song } from "@strumm/types";
import { apiFetch } from "web/lib/api-client";
import { useAuthStore } from "web/store/useAuthStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadioState {
  isRadio: boolean;
  radioSeed: string | null;
  radioSession: string | null;
}

export interface RadioActions {
  startRadio: (seedVideoId: string, initialSongs: Song[]) => void;
  stopRadio: () => void;
  fetchMoreRadio: () => Promise<void>;
  setRadioSession: (session: string | null) => void;
  triggerRadio: (seedVideoId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const initialRadioState: RadioState = {
  isRadio: false,
  radioSeed: null,
  radioSession: null,
};

// ---------------------------------------------------------------------------
// Action factories (call from the store)
// ---------------------------------------------------------------------------

export function createRadioActions(
  set: (partial: Partial<Record<string, any>>) => void,
  get: () => any,
): RadioActions {
  return {
    startRadio: (seedVideoId, initialSongs) => {
      set({
        queue: initialSongs,
        currentIndex: 0,
        isRadio: true,
        radioSeed: seedVideoId,
        radioSession: `radio_${seedVideoId}_${Date.now()}`,
        isShuffle: false,
        repeatMode: "none",
      });
      if (initialSongs.length > 0) {
        const song = initialSongs[0];
        set({ currentSong: song, isPlaying: true, currentTime: 0 });
        get().updateMediaSession(song);
      }
    },

    stopRadio: () => {
      set({ isRadio: false, radioSeed: null, radioSession: null });
    },

    setRadioSession: (session) => {
      set({ radioSession: session });
    },

    triggerRadio: async (seedVideoId) => {
      const { isRadio, radioSeed } = get();
      if (isRadio && radioSeed === seedVideoId) return;

      try {
        const token = useAuthStore.getState().token;
        const data = await apiFetch<{ songs: Song[] }>(
          `/radio/${seedVideoId}?limit=20`,
          { token },
        );
        if (data?.songs?.length > 0) {
          get().startRadio(seedVideoId, data.songs);
        }
      } catch (e) {
        console.error("Failed to start radio:", e);
      }
    },

    fetchMoreRadio: async () => {
      const { radioSeed, queue, isRadio } = get();
      if (!isRadio || !radioSeed) return;

      try {
        const token = useAuthStore.getState().token;
        const data = await apiFetch<{ songs: Song[] }>(
          `/radio/${radioSeed}?limit=20`,
          { token },
        );
        if (data?.songs) {
          const existingVids = new Set(queue.map((s: Song) => s.videoId));
          const newSongs = data.songs.filter((s: Song) => !existingVids.has(s.videoId));
          if (newSongs.length > 0) {
            set({ queue: [...queue, ...newSongs] });
          } else {
            console.warn("Radio: No new tracks available");
          }
        }
      } catch (e) {
        console.error("Failed to fetch more radio tracks:", e);
      }
    },
  };
}
