import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Song } from "@strumm/types";
import { updateMediaSession } from "web/store/media-session-utils";
import { createRadioActions, initialRadioState } from "web/store/radio-actions";
import { createSleepTimerActions, initialSleepTimerState, type SleepTimerDuration } from "web/store/sleep-timer-utils";

type RepeatMode = "none" | "all" | "one";

function resolveNextTrackIndex(
  queue: Song[],
  currentIndex: number,
  repeatMode: RepeatMode,
  isShuffle: boolean,
  onTrackEnd: boolean,
  shufflePlayedIds: string[] = []
): number | null {
  if (queue.length === 0) return null;

  if (isShuffle) {
    if (queue.length === 1) {
      return onTrackEnd && repeatMode !== "all" ? null : 0;
    }

    // Build set of videoIds already played in this shuffle round
    const playedSet = new Set(shufflePlayedIds);

    // Find indices for songs not yet played
    let eligibleIndices = queue
      .map((song, idx) => ({ song, idx }))
      .filter(({ song }) => !playedSet.has(song.videoId))
      .map(({ idx }) => idx);

    // If all songs have been played, reset and start a new round
    if (eligibleIndices.length === 0) {
      eligibleIndices = queue.map((_, idx) => idx);
    }

    // Remove current index to avoid playing the same song twice in a row
    const filtered = eligibleIndices.filter((idx) => idx !== currentIndex);

    if (filtered.length === 0) {
      // Only the current song is eligible (single-song queue handled above)
      return eligibleIndices[0];
    }

    return filtered[Math.floor(Math.random() * filtered.length)];
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

  audioQuality: "data-saver" | "balanced" | "high";
  isPlayerLoading: boolean;
  playerError: string | null;

  // Sleep Timer
  sleepTimerDuration: SleepTimerDuration;
  sleepTimerEndTime: number | null;
   
  // Radio Mode
  isRadio: boolean;
  isRadioLoading: boolean;
  radioSeed: string | null;
  radioSession: string | null;
  radioHistory: string[];
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

  // Shuffle history — tracks videoIds played during the current shuffle round
  shufflePlayedIds: string[];

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
      shufflePlayedIds: [],
      playbackRate: 1.0,
      podcastMode: "audio",

      audioQuality: "balanced",
      playerRef: null,
      isPlayerLoading: false,
      playerError: null,
      ...initialRadioState,
      ...initialSleepTimerState,
      
      // Radio actions
      ...createRadioActions(set, get),

      // Sleep timer actions
      ...createSleepTimerActions(set, get),

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
          shufflePlayedIds: [], // Reset shuffle history when playing a new song
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
        const { queue, currentIndex, repeatMode, isShuffle, currentSong, shufflePlayedIds } = get();

        // Mark current song as played in shuffle history
        let updatedPlayedIds = shufflePlayedIds;
        if (isShuffle && currentSong?.videoId) {
          updatedPlayedIds = [...shufflePlayedIds, currentSong.videoId];
          set({ shufflePlayedIds: updatedPlayedIds });
        }

        const nextIdx = resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, false, updatedPlayedIds);
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

      setShuffle: (isShuffle) => {
        if (isShuffle) {
          const { currentSong } = get();
          set({
            isShuffle: true,
            shufflePlayedIds: currentSong?.videoId ? [currentSong.videoId] : [],
          });
        } else {
          set({ isShuffle: false, shufflePlayedIds: [] });
        }
      },

      setRepeatMode: (repeatMode) => set({ repeatMode }),

      setReducedAnimation: (reducedAnimation) => set({ reducedAnimation }),

      setPodcastMode: (podcastMode) => set({ podcastMode }),

      handleTrackEnded: () => {
        const { queue, currentIndex, repeatMode, isShuffle, playerRef, currentSong, shufflePlayedIds } = get();
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

        // Mark current song as played in shuffle history
        let updatedPlayedIds = shufflePlayedIds;
        if (isShuffle && currentSong?.videoId) {
          updatedPlayedIds = [...shufflePlayedIds, currentSong.videoId];
          set({ shufflePlayedIds: updatedPlayedIds });
        }

        const nextIdx = resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, true, updatedPlayedIds);
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
        updateMediaSession(song, get);
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
        shufflePlayedIds: state.shufflePlayedIds,
  
        audioQuality: state.audioQuality,
      }),
    }
  )
);
