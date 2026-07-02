import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Song } from "@strumm/types";
import { getBestArtwork } from "web/lib/media";
import { apiUrl } from "web/lib/api";
import { useAuthStore } from "web/store/useAuthStore";

type RepeatMode = "none" | "all" | "one";

type SleepTimerDuration = 15 | 30 | 45 | 60 | "end-of-track" | null;

function resolveNextTrackIndex(
  queue: Song[],
  currentIndex: number,
  repeatMode: RepeatMode,
  isShuffle: boolean,
  onTrackEnd: boolean
): number | null {
  if (queue.length === 0) return null;

  if (isShuffle) {
    if (queue.length === 1) {
      return onTrackEnd && repeatMode !== "all" ? null : 0;
    }
    let nextIdx = currentIndex;
    do {
      nextIdx = Math.floor(Math.random() * queue.length);
    } while (nextIdx === currentIndex);
    return nextIdx;
  }

  const nextIdx = currentIndex + 1;
  if (nextIdx >= queue.length) {
    if (repeatMode === "all") return 0;
    return onTrackEnd ? null : queue.length - 1;
  }
  return nextIdx;
}

function playTrackAtIndex(
  queue: Song[],
  index: number,
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState
) {
  const song = queue[index];
  set({
    currentSong: song,
    currentIndex: index,
    isPlaying: true,
    currentTime: 0,
  });
  get().updateMediaSession(song);
}

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
  podcastMode: "audio" | "video";

  /** Whether the user has explicitly chosen to watch the current song as video. */
  videoMode: boolean;

  audioQuality: "data-saver" | "balanced" | "high";
  isPlayerLoading: boolean;
  playerError: string | null;

  // Sleep Timer
  sleepTimerDuration: SleepTimerDuration;
  sleepTimerEndTime: number | null;
   
  // Radio Mode
  isRadio: boolean;
  radioSeed: string | null;
  radioSession: string | null;
  startRadio: (seedVideoId: string, initialSongs: Song[]) => void;
  stopRadio: () => void;
  fetchMoreRadio: () => Promise<void>;
  setRadioSession: (session: string | null) => void;
  triggerRadio: (seedVideoId: string) => Promise<void>;
  
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
  setAudioQuality: (quality: "data-saver" | "balanced" | "high") => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setRepeatMode: (mode: "none" | "all" | "one") => void;
  setReducedAnimation: (reduced: boolean) => void;
  setPodcastMode: (mode: "audio" | "video") => void;
  /** Toggle video mode on/off for the current YouTube song (non-podcast). */
  toggleVideoMode: () => void;
  handleTrackEnded: () => void;
  restorePlayerState: (state: Partial<PlayerState>) => void;
  setPlayerLoading: (loading: boolean) => void;
  setPlayerError: (error: string | null) => void;
  
  // YouTube API integration callbacks
  playerRef: {
    playVideo: () => void;
    pauseVideo: () => void;
    seekTo: (seconds: number) => void;
    setVolume: (volume: number) => void;
    setPlaybackRate: (rate: number) => void;
    setPlaybackQuality?: (quality: string) => void;
  } | null;
  setPlayerRef: (ref: any) => void;
  updateMediaSession: (song: Song) => void;

  // Sleep Timer Actions
  setSleepTimer: (duration: SleepTimerDuration) => void;
  clearSleepTimer: () => void;
  checkSleepTimer: () => void;
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
      podcastMode: "audio",
      videoMode: false,
      audioQuality: "balanced",
      playerRef: null,
      isPlayerLoading: false,
      playerError: null,
      isRadio: false,
      radioSeed: null,
      radioSession: null,
      sleepTimerDuration: null,
      sleepTimerEndTime: null,
      
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

      triggerRadio: async (seedVideoId: string) => {
        const { isRadio, radioSeed } = get();
        // Don't restart if already playing radio from this seed
        if (isRadio && radioSeed === seedVideoId) return;

        try {
          const token = useAuthStore.getState().token;
          const headers: Record<string, string> = {};
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          const res = await fetch(apiUrl(`/radio/${seedVideoId}?limit=20`), { headers });
          const json = await res.json();
          if (json.success && json.data?.songs?.length > 0) {
            get().startRadio(seedVideoId, json.data.songs);
          }
        } catch (e) {
          console.error("Failed to start radio:", e);
        }
      },

      fetchMoreRadio: async () => {
        const { radioSeed, queue, isRadio } = get();
        if (!isRadio || !radioSeed) return;

        try {
          const res = await fetch(apiUrl(`/radio/${radioSeed}?limit=20`));
          const json = await res.json();
          if (json.success && json.data?.songs) {
            const existingVids = new Set(queue.map(s => s.videoId));
            const newSongs = json.data.songs.filter((s: any) => !existingVids.has(s.videoId));
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

      // Sleep Timer Actions
      setSleepTimer: (duration: SleepTimerDuration) => {
        const { duration: songDuration } = get();
        if (!duration) {
          set({ sleepTimerDuration: null, sleepTimerEndTime: null });
          return;
        }

        let endTime: number;
        if (duration === "end-of-track") {
          // End of current track - use remaining time
          const remaining = Math.max(0, songDuration - get().currentTime);
          endTime = Date.now() + remaining * 1000;
        } else {
          // Fixed duration in minutes
          endTime = Date.now() + duration * 60 * 1000;
        }

        set({
          sleepTimerDuration: duration,
          sleepTimerEndTime: endTime,
        });
      },

      clearSleepTimer: () => {
        set({ sleepTimerDuration: null, sleepTimerEndTime: null });
      },

      checkSleepTimer: () => {
        const { sleepTimerEndTime, isPlaying, togglePlay } = get();
        if (sleepTimerEndTime && isPlaying && Date.now() >= sleepTimerEndTime) {
          togglePlay();
          set({ sleepTimerDuration: null, sleepTimerEndTime: null });
        }
      },

      setPlayerLoading: (loading) => set({ isPlayerLoading: loading }),
      setPlayerError: (error) => set({ playerError: error }),

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
          // Reset video mode on track change — opt-in per song
          videoMode: false,
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
        const nextIdx = resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, false);
        if (nextIdx === null || nextIdx < 0 || nextIdx >= queue.length) return;
        playTrackAtIndex(queue, nextIdx, set, get);
      },

      prev: () => {
        const { queue, currentIndex, currentTime, playerRef } = get();
        if (queue.length === 0) return;

        if (currentTime > 5) {
          playerRef?.seekTo(0);
          set({ currentTime: 0, isPlaying: true });
          return;
        }

        const prevIdx = Math.max(0, currentIndex - 1);
        playTrackAtIndex(queue, prevIdx, set, get);
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

      setAudioQuality: (audioQuality) => {
        set({ audioQuality });
        const qualityMap = {
          "data-saver": "small",
          balanced: "medium",
          high: "hd720",
        } as const;
        const { playerRef } = get();
        if (playerRef && typeof playerRef.setPlaybackQuality === "function") {
          playerRef.setPlaybackQuality(qualityMap[audioQuality]);
        }
      },

      setCurrentTime: (currentTime) => set({ currentTime }),
      
      setDuration: (duration) => set({ duration }),

      setShuffle: (isShuffle) => set({ isShuffle }),

      setRepeatMode: (repeatMode) => set({ repeatMode }),

      setReducedAnimation: (reducedAnimation) => set({ reducedAnimation }),

      setPodcastMode: (podcastMode) => set({ podcastMode }),

      toggleVideoMode: () => {
        const { videoMode } = get();
        set({ videoMode: !videoMode });
      },

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

        const nextIdx = resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, true);
        if (nextIdx === null) {
          set({ isPlaying: false, currentTime: 0 });
          return;
        }

        playTrackAtIndex(queue, nextIdx, set, get);
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
          audioQuality: state.audioQuality ?? get().audioQuality,
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
          if (typeof playerRef.setPlaybackQuality === "function") {
            const qualityMap = {
              "data-saver": "small",
              balanced: "medium",
              high: "hd720",
            } as const;
            playerRef.setPlaybackQuality(qualityMap[get().audioQuality]);
          }
        }
      },

      // Helper function to update system lockscreen metadata (Media Session API)
      updateMediaSession: (song: Song) => {
        if (typeof window !== "undefined" && "mediaSession" in navigator) {
          const artworkSrc = getBestArtwork(song) || song.thumbnail;
          
          // Force secure thumbnail to prevent mixed content issues
          let secureArtwork = artworkSrc;
          if (secureArtwork && secureArtwork.startsWith("http://")) {
            secureArtwork = secureArtwork.replace("http://", "https://");
          }

          navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: song.metadata?.album || "Strumm",
            artwork: [
              { src: secureArtwork || "", sizes: "96x96", type: "image/jpeg" },
              { src: secureArtwork || "", sizes: "128x128", type: "image/jpeg" },
              { src: secureArtwork || "", sizes: "192x192", type: "image/jpeg" },
              { src: secureArtwork || "", sizes: "256x256", type: "image/jpeg" },
              { src: secureArtwork || "", sizes: "384x384", type: "image/jpeg" },
              { src: secureArtwork || "", sizes: "512x512", type: "image/jpeg" },
            ],
          });

          // Setup system lockscreen media control actions
          navigator.mediaSession.setActionHandler("play", () => {
            const { isPlaying, playerRef } = get();
            if (!isPlaying) {
              playerRef?.playVideo();
              set({ isPlaying: true });
            }
          });
          navigator.mediaSession.setActionHandler("pause", () => {
            const { isPlaying, playerRef } = get();
            if (isPlaying) {
              playerRef?.pauseVideo();
              set({ isPlaying: false });
            }
          });
          navigator.mediaSession.setActionHandler("previoustrack", () => {
            const { currentTime, prev, playerRef } = get();
            if (currentTime > 5) {
              playerRef?.seekTo(0);
              set({ currentTime: 0 });
            } else {
              prev();
            }
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
          navigator.mediaSession.setActionHandler("seekbackward", (details) => {
            const offset = details.seekOffset || 10;
            const targetTime = Math.max(0, get().currentTime - offset);
            get().playerRef?.seekTo(targetTime);
            set({ currentTime: targetTime });
          });
          navigator.mediaSession.setActionHandler("seekforward", (details) => {
            const offset = details.seekOffset || 10;
            const targetTime = Math.min(get().duration, get().currentTime + offset);
            get().playerRef?.seekTo(targetTime);
            set({ currentTime: targetTime });
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
        podcastMode: state.podcastMode,
        videoMode: false,
        audioQuality: state.audioQuality,
      }),
    }
  )
);
