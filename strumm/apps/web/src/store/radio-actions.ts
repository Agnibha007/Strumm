/**
 * Radio mode actions extracted from usePlayerStore.
 *
 * These helpers wrap the radio start/stop/fetch logic so the main store file
 * can stay lean.  Each factory receives `set` and `get` from the store.
 */
import { Song } from "@strumm/types";
import { apiFetch } from "web/lib/api-client";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadioState {
  isRadio: boolean;
  radioSeed: string | null;
  radioSession: string | null;
  radioHistory: string[];  // videoIds seen during current radio session
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
  radioHistory: [],
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
      const historyVids = [
        seedVideoId,
        ...initialSongs.map((s) => s.videoId),
      ];
      set({
        queue: initialSongs,
        currentIndex: 0,
        isRadio: true,
        radioSeed: seedVideoId,
        radioSession: `radio_${seedVideoId}_${Date.now()}`,
        radioHistory: historyVids.filter(Boolean) as string[],
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
      set({ isRadio: false, radioSeed: null, radioSession: null, radioHistory: [] });
    },

    setRadioSession: (session) => {
      set({ radioSession: session });
    },

    triggerRadio: async (seedVideoId) => {
      const { isRadio, radioSeed, radioHistory } = get();
      if (isRadio && radioSeed === seedVideoId) return;

      try {
        const token = useAuthStore.getState().token;
        // Pass session history as exclude so we don't repeat tracks
        const excludeParam = radioHistory.length > 0
          ? `&exclude=${radioHistory.join(",")}`
          : "";
        const data = await apiFetch<{ songs: Song[] }>(
          `/radio/${seedVideoId}?limit=20${excludeParam}`,
          { token },
        );
        if (data?.songs?.length > 0) {
          get().startRadio(seedVideoId, data.songs);
        } else {
          useNotificationStore.getState().show(
            "Couldn't find related tracks for this song.",
            "warning",
          );
        }
      } catch (e) {
        console.error("Failed to start radio:", e);
        useNotificationStore.getState().show(
          "Couldn't start radio — no related tracks found for this song.",
          "error",
        );
      }
    },

    fetchMoreRadio: async () => {
      const { radioSeed, queue, isRadio, radioHistory } = get();
      if (!isRadio || !radioSeed) return;

      try {
        const token = useAuthStore.getState().token;
        // Pass full session history as exclude so backend returns fresh tracks
        const excludeParam = radioHistory.length > 0
          ? `&exclude=${radioHistory.join(",")}`
          : "";
        const data = await apiFetch<{ songs: Song[] }>(
          `/radio/${radioSeed}?limit=20${excludeParam}`,
          { token },
        );
        if (data?.songs) {
          const existingVids = new Set(queue.map((s: Song) => s.videoId));
          const newSongs = data.songs.filter((s: Song) => !existingVids.has(s.videoId));
          if (newSongs.length > 0) {
            // Add new song videoIds to radio history for future dedup
            const newVids = newSongs.map((s: Song) => s.videoId).filter(Boolean) as string[];
            set({
              queue: [...queue, ...newSongs],
              radioHistory: [...radioHistory, ...newVids],
            });
          } else {
            console.warn("Radio: No new tracks available");
          }
        }
      } catch (e) {
        console.error("Failed to fetch more radio tracks:", e);
        useNotificationStore.getState().show(
          "Couldn't load more radio tracks.",
          "warning",
        );
      }
    },
  };
}
