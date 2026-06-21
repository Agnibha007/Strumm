import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Song } from "@strumm/types";
import { getBestArtwork } from "web/lib/media";

interface PlayerState {
  currentSong: Song | null;
  queue: Song[];
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  isShuffle: boolean;
  repeatMode: "none" | "all" | "one";
  reducedAnimation: boolean;
  playbackRate: number;
  
  // Actions
  setCurrentSong: (song: Song | null) => void;
  setQueue: (queue: Song[]) => void;
  addToQueue: (song: Song) => void;
  playSong: (song: Song, contextQueue?: Song[]) => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
  next: () => void;
  prev: () => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setRepeatMode: (mode: "none" | "all" | "one") => void;
  setReducedAnimation: (reduced: boolean) => void;
  handleTrackEnded: () => void;
  restorePlayerState: (state: Partial<PlayerState>) => void;
  
  // YouTube API integration callbacks
  playerRef: {
    playVideo: () => void;
    pauseVideo: () => void;
    seekTo: (seconds: number) => void;
    setVolume: (volume: number) => void;
    setPlaybackRate: (rate: number) => void;
  } | null;
  setPlayerRef: (ref: any) => void;
  updateMediaSession: (song: Song) => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentSong: null,
      queue: [],
      currentIndex: -1,
      isPlaying: false,
      volume: 0.8,
      currentTime: 0,
      duration: 0,
      isShuffle: false,
      repeatMode: "none",
      reducedAnimation: false,
      playbackRate: 1.0,
      playerRef: null,

      setCurrentSong: (song) => {
        set({ currentSong: song });
        if (song) {
          get().updateMediaSession(song);
        }
      },

      setQueue: (queue) => {
        set({ queue });
      },

      addToQueue: (song) => {
        const { queue } = get();
        if (!queue.some((s) => s.videoId === song.videoId)) {
          set({ queue: [...queue, song] });
        }
      },

      playSong: (song, contextQueue) => {
        const currentQueue = contextQueue || get().queue;
        const existsInQueue = currentQueue.some((s) => s.videoId === song.videoId);
        
        let newQueue = [...currentQueue];
        if (!existsInQueue) {
          newQueue = [...newQueue, song];
        }

        const idx = newQueue.findIndex((s) => s.videoId === song.videoId);

        set({
          currentSong: song,
          queue: newQueue,
          currentIndex: idx,
          isPlaying: true,
          currentTime: 0,
        });

        get().updateMediaSession(song);
      },

      togglePlay: () => {
        const { isPlaying, playerRef } = get();
        if (isPlaying) {
          playerRef?.pauseVideo();
          set({ isPlaying: false });
        } else {
          playerRef?.playVideo();
          set({ isPlaying: true });
        }
      },

      setPlaying: (playing) => {
        set({ isPlaying: playing });
      },

      next: () => {
        const { queue, currentIndex, repeatMode, isShuffle } = get();
        if (queue.length === 0) return;

        let nextIdx = currentIndex;

        if (isShuffle) {
          if (queue.length === 1) {
            nextIdx = 0;
          } else {
            do {
              nextIdx = Math.floor(Math.random() * queue.length);
            } while (nextIdx === currentIndex);
          }
        } else {
          nextIdx = currentIndex + 1;
          if (nextIdx >= queue.length) {
            nextIdx = repeatMode === "all" ? 0 : queue.length - 1;
          }
        }

        if (nextIdx >= 0 && nextIdx < queue.length) {
          const nextSong = queue[nextIdx];
          set({
            currentSong: nextSong,
            currentIndex: nextIdx,
            isPlaying: true,
            currentTime: 0,
          });
          get().updateMediaSession(nextSong);
        }
      },

      prev: () => {
        const { queue, currentIndex, playerRef } = get();
        if (queue.length === 0) return;

        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) {
          prevIdx = 0; // standard behavior: restart first track
        }

        const prevSong = queue[prevIdx];
        set({
          currentSong: prevSong,
          currentIndex: prevIdx,
          isPlaying: true,
          currentTime: 0,
        });
        get().updateMediaSession(prevSong);
      },

      setVolume: (volume) => {
        set({ volume });
        const { playerRef } = get();
        if (playerRef && typeof playerRef.setVolume === "function") {
          playerRef.setVolume(Math.round(volume * 100));
        }
      },

      setPlaybackRate: (rate) => {
        set({ playbackRate: rate });
        const { playerRef } = get();
        if (playerRef && typeof playerRef.setPlaybackRate === "function") {
          playerRef.setPlaybackRate(rate);
        }
      },

      setCurrentTime: (currentTime) => set({ currentTime }),
      
      setDuration: (duration) => set({ duration }),

      setShuffle: (isShuffle) => set({ isShuffle }),

      setRepeatMode: (repeatMode) => set({ repeatMode }),

      setReducedAnimation: (reducedAnimation) => set({ reducedAnimation }),

      handleTrackEnded: () => {
        const { queue, currentIndex, repeatMode, isShuffle, playerRef } = get();
        if (!queue.length) {
          set({ isPlaying: false, currentTime: 0 });
          return;
        }

        if (repeatMode === "one") {
          playerRef?.seekTo(0);
          playerRef?.playVideo();
          set({ currentTime: 0, isPlaying: true });
          return;
        }

        let nextIdx = currentIndex;
        if (isShuffle) {
          if (queue.length === 1) {
            if (repeatMode === "all") {
              nextIdx = 0;
            } else {
              set({ isPlaying: false, currentTime: 0 });
              return;
            }
          } else {
            do {
              nextIdx = Math.floor(Math.random() * queue.length);
            } while (nextIdx === currentIndex);
          }
        } else {
          nextIdx = currentIndex + 1;
          if (nextIdx >= queue.length) {
            if (repeatMode === "all") {
              nextIdx = 0;
            } else {
              set({ isPlaying: false, currentTime: 0 });
              return;
            }
          }
        }

        const nextSong = queue[nextIdx];
        set({
          currentSong: nextSong,
          currentIndex: nextIdx,
          isPlaying: true,
          currentTime: 0,
        });
        get().updateMediaSession(nextSong);
      },

      restorePlayerState: (state) => {
        set({
          currentSong: state.currentSong ?? null,
          queue: state.queue ?? [],
          currentIndex: state.currentIndex ?? -1,
          isPlaying: false,
          currentTime: state.currentTime ?? 0,
          volume: state.volume ?? get().volume,
          isShuffle: state.isShuffle ?? false,
          repeatMode: state.repeatMode ?? "none",
          playbackRate: state.playbackRate ?? 1,
        });
        if (state.currentSong) {
          get().updateMediaSession(state.currentSong);
        }
      },

      setPlayerRef: (playerRef) => {
        set({ playerRef });
        // Set volume and rate immediately upon initialization
        if (playerRef) {
          if (typeof playerRef.setVolume === "function") {
            playerRef.setVolume(Math.round(get().volume * 100));
          }
          if (typeof playerRef.setPlaybackRate === "function") {
            playerRef.setPlaybackRate(get().playbackRate);
          }
        }
      },

      // Helper function to update system lockscreen metadata (Media Session API)
      updateMediaSession: (song: Song) => {
        if (typeof window !== "undefined" && "mediaSession" in navigator) {
          const artworkSrc = getBestArtwork(song) || song.thumbnail;
          navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: song.metadata?.album || "Strumm Ecosystem",
            artwork: [
              { src: artworkSrc, sizes: "96x96", type: "image/jpeg" },
              { src: artworkSrc, sizes: "128x128", type: "image/jpeg" },
              { src: artworkSrc, sizes: "192x192", type: "image/jpeg" },
              { src: artworkSrc, sizes: "256x256", type: "image/jpeg" },
              { src: artworkSrc, sizes: "384x384", type: "image/jpeg" },
              { src: artworkSrc, sizes: "512x512", type: "image/jpeg" },
            ],
          });

          // Setup system lockscreen media control actions
          navigator.mediaSession.setActionHandler("play", () => {
            get().playerRef?.playVideo();
            set({ isPlaying: true });
          });
          navigator.mediaSession.setActionHandler("pause", () => {
            get().playerRef?.pauseVideo();
            set({ isPlaying: false });
          });
          navigator.mediaSession.setActionHandler("previoustrack", () => {
            get().prev();
          });
          navigator.mediaSession.setActionHandler("nexttrack", () => {
            get().next();
          });
          navigator.mediaSession.setActionHandler("seekto", (details) => {
            if (details.seekTime !== undefined) {
              get().playerRef?.seekTo(details.seekTime);
              set({ currentTime: details.seekTime });
            }
          });
        }
      },
    }),
    {
      name: "strumm-player-cache",
      partialize: (state) => ({
        volume: state.volume,
        currentSong: state.currentSong,
        queue: state.queue,
        currentIndex: state.currentIndex,
        isShuffle: state.isShuffle,
        repeatMode: state.repeatMode,
        reducedAnimation: state.reducedAnimation,
        playbackRate: state.playbackRate,
      }),
    }
  )
);
