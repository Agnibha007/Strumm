import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Song } from "@strumm/types";
import { decodeHtml } from "web/lib/api";
import { updateMediaSession } from "web/store/media-session-utils";
import { createRadioActions, initialRadioState } from "web/store/radio-actions";
import { createSleepTimerActions, initialSleepTimerState, type SleepTimerDuration } from "web/store/sleep-timer-utils";
import { resolveNextTrackIndex } from "web/store/queue-utils";

// HTML entities (e.g. &quot;, &amp;quot;) can end up in titles stored in the
// DB / player cache. Decode them once as songs enter the store so every
// render (player, queue, lists) shows clean text.
function cleanSong(song: Song): Song {
  if (!song) return song;
  return {
    ...song,
    title: decodeHtml(song.title ?? ""),
    artist: decodeHtml(song.artist ?? ""),
    metadata: song.metadata
      ? { ...song.metadata, album: song.metadata.album ? decodeHtml(song.metadata.album) : undefined }
      : song.metadata,
  };
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
        const cleaned = song ? cleanSong(song) : song;
        set({ currentSong: cleaned });
        if (cleaned) {
          get().updateMediaSession(cleaned);
        }
      },

      setQueue: (queue) => {
        set({ queue: queue.map(cleanSong) });
      },

      addToQueue: (song) => {
        const { queue } = get();
        const cleaned = cleanSong(song);
        if (!queue.some((s) => s.videoId === cleaned.videoId)) {
          set({ queue: [...queue, cleaned] });
        }
      },

      playSong: (song, contextQueue) => {
        const cleaned = cleanSong(song);
        const currentQueue = (contextQueue || get().queue).map(cleanSong);
        const existsInQueue = currentQueue.some((s) => s.videoId === cleaned.videoId);

        let newQueue = [...currentQueue];
        if (!existsInQueue) {
          newQueue = [...newQueue, cleaned];
        }

        const idx = newQueue.findIndex((s) => s.videoId === cleaned.videoId);

        set({
          currentSong: cleaned,
          queue: newQueue,
          currentIndex: idx,
          isPlaying: true,
          currentTime: 0,
          shufflePlayedIds: [], // Reset shuffle history when playing a new song
        });

        get().updateMediaSession(cleaned);
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
        const currentSong = state.currentSong ? cleanSong(state.currentSong) : null;
        set({
          currentSong,
          queue: (state.queue ?? []).map(cleanSong),
          currentIndex: state.currentIndex ?? -1,
          isPlaying: false,
          currentTime: state.currentTime ?? 0,
          volume: state.volume ?? get().volume,
          isShuffle: state.isShuffle ?? false,
          repeatMode: state.repeatMode ?? "none",
          playbackRate: state.playbackRate ?? 1,
          audioQuality: state.audioQuality ?? get().audioQuality,
        });
        if (currentSong) {
          get().updateMediaSession(currentSong);
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
