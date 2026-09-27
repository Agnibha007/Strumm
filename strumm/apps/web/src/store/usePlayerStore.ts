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
    duration: 0,
    // Any track change retires the crossfade's next-track commitment: it was
    // made for the song that just finished and must never hijack this advance.
    pendingNextIndex: null,
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
  playSongAndContinue: (song: Song) => void;
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
  applyRemoteState: (state: Partial<PlayerState>) => void;
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
  // Monotonic seek counter bumped whenever a seek is issued through the player
  // ref, so the listening-time tracker can treat the jump as a seek instead of
  // counting skipped seconds.
  seekCount: number;
  notifySeek: (seconds: number) => void;
  updateMediaSession: (song: Song) => void;

  // Shuffle history — tracks videoIds played during the current shuffle round
  shufflePlayedIds: string[];

  /**
   * The queue index the crossfade has committed to playing next, or null.
   *
   * A real crossfade has to name the incoming track *before* it starts playing
   * it, so the engine can pre-buffer and ramp that exact stream. Under shuffle
   * the next index is a fresh random pick, so asking the queue resolver twice
   * (once to pre-buffer, once to advance) yields two DIFFERENT tracks — the
   * overlap then plays a song the queue never reaches, and the boundary lands
   * somewhere else entirely. That is why the crossfade was disabled whenever
   * shuffle was on.
   *
   * Committing the choice here makes staging, the audible overlap, and the
   * advance all agree on one track, and it is what makes the crossfade work
   * under shuffle. Transient by design: cleared by every track change, queue
   * edit, mode toggle and pause, and deliberately NOT persisted.
   */
  pendingNextIndex: number | null;
  setPendingNextIndex: (index: number | null) => void;

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
      pendingNextIndex: null,
      playbackRate: 1.0,
      podcastMode: "audio",

      audioQuality: "balanced",
      playerRef: null,
      seekCount: 0,
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
        // Rewriting the queue retires the crossfade's next-track commitment —
        // the index it named may no longer be the track that plays next.
        set({ queue: queue.map(cleanSong), pendingNextIndex: null });
      },

      addToQueue: (song) => {
        const { queue } = get();
        const cleaned = cleanSong(song);
        if (!queue.some((s) => s.videoId === cleaned.videoId)) {
          // Appending never invalidates a committed index (it points at an
          // existing slot), so the commitment is deliberately kept.
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
          pendingNextIndex: null,
        });

        get().updateMediaSession(cleaned);
      },

      // Play ONE song and then keep the mix going with related tracks.
      //
      // `playSong(song, contextQueue)` REPLACES the queue with the whole
      // context list, which is right for a playlist or an album and wrong for
      // search: picking one result out of thirty meant the other twenty-nine
      // silently became the up-next queue and played for the next half hour.
      //
      // This enqueues ONLY the picked song, then hands the queue to the mix
      // (radio) machinery seeded with that song. The mix tops the queue up in
      // the background — so the picked song plays first and the continuation is
      // already buffered and ready when it ends, with no gap.
      playSongAndContinue: (song) => {
        const cleaned = cleanSong(song);
        set({
          currentSong: cleaned,
          queue: [cleaned],
          currentIndex: 0,
          isPlaying: true,
          currentTime: 0,
          duration: 0,
          shufflePlayedIds: [],
          pendingNextIndex: null,
        });
        get().updateMediaSession(cleaned);
        // Seeding the mix with the picked song means the continuation is
        // related to what the user actually chose, not to the search query.
        get().startRadio(cleaned.videoId, [cleaned]);
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

        // A crossfade names the track it is fading into before it plays it (it
        // has to, to pre-buffer and ramp that exact stream). Honour that
        // commitment so the advance lands on the song the listener is already
        // hearing fade in. Under shuffle, re-resolving instead would pick a
        // DIFFERENT random track and cut the crossfade off mid-blend.
        const committed = get().pendingNextIndex;
        set({ pendingNextIndex: null });
        const nextIdx =
          committed !== null && committed >= 0 && committed < queue.length
            ? committed
            : resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, false, updatedPlayedIds);
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
          const { currentSong, repeatMode } = get();
          set({
            isShuffle: true,
            shufflePlayedIds: currentSong?.videoId ? [currentSong.videoId] : [],
            // Repeat-one repeats the current track, which is incompatible
            // with shuffle picking random tracks — turn it off.
            repeatMode: repeatMode === "one" ? "none" : repeatMode,
            // Toggling the play order changes which track plays next, so any
            // committed next-track is stale.
            pendingNextIndex: null,
          });
        } else {
          set({ isShuffle: false, shufflePlayedIds: [], pendingNextIndex: null });
        }
      },

      setRepeatMode: (repeatMode) => {
        if (repeatMode === "one" && get().isShuffle) {
          set({ repeatMode, isShuffle: false, shufflePlayedIds: [], pendingNextIndex: null });
        } else {
          set({ repeatMode, pendingNextIndex: null });
        }
      },

      setReducedAnimation: (reducedAnimation) => set({ reducedAnimation }),

      setPodcastMode: (podcastMode) => set({ podcastMode }),

      handleTrackEnded: () => {
        const { queue, currentIndex, repeatMode, isShuffle, playerRef, currentSong, shufflePlayedIds, isPlaying } = get();

        // A paused player must never auto-advance.
        //
        // `handleTrackEnded` is the "the current track finished" choke point, and
        // many things can call it late: a crossfade fade-out that was already in
        // flight when the user hit pause, a `timeupdate` near the end, the
        // `ended` event, and the background watchdog. Any of those landing after
        // an explicit pause used to call playTrackAtIndex → isPlaying: true,
        // which is the reported "I paused it and a few seconds later it started
        // playing again". Pausing is a hard stop, not a request.
        //
        // Deliberate skips (media-key next, error recovery) go through `next()`,
        // which stays ungated.
        if (!isPlaying) return;

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

        // Honour the crossfade's committed next track (see setPendingNextIndex).
        // Without this, `ended` would re-resolve and land on a different random
        // track than the one already fading in.
        const committed = get().pendingNextIndex;
        set({ pendingNextIndex: null });
        const nextIdx =
          committed !== null && committed >= 0 && committed < queue.length
            ? committed
            : resolveNextTrackIndex(queue, currentIndex, repeatMode, isShuffle, true, updatedPlayedIds);
        if (nextIdx === null) {
          set({ isPlaying: false, currentTime: 0 });
          return;
        }

        playTrackAtIndex(queue, nextIdx, set, get);
      },

      setPendingNextIndex: (index) => {
        const { queue, currentIndex } = get();
        // Only ever commit a real, in-range slot. A stale or out-of-range
        // commitment would either be ignored here or hijack an unrelated
        // advance, so it is dropped rather than stored.
        if (index === null) {
          set({ pendingNextIndex: null });
          return;
        }
        if (!Number.isInteger(index) || index < 0 || index >= queue.length || index === currentIndex) {
          set({ pendingNextIndex: null });
          return;
        }
        set({ pendingNextIndex: index });
      },

      restorePlayerState: (state) => {
        const currentSong = state.currentSong ? cleanSong(state.currentSong) : null;
        const isShuffle = state.isShuffle ?? false;
        const repeatMode = state.repeatMode ?? "none";
        set({
          currentSong,
          queue: (state.queue ?? []).map(cleanSong),
          currentIndex: state.currentIndex ?? -1,
          isPlaying: false,
          currentTime: state.currentTime ?? 0,
          volume: state.volume ?? get().volume,
          isShuffle,
          // Shuffle and repeat-one are mutually exclusive — never restore a
          // persisted state where both are active.
          repeatMode: isShuffle && repeatMode === "one" ? "none" : repeatMode,
          playbackRate: state.playbackRate ?? 1,
          audioQuality: state.audioQuality ?? get().audioQuality,
          pendingNextIndex: null,
        });
        if (currentSong) {
          get().updateMediaSession(currentSong);
        }
      },

      // Cross-device (crossplay) state application. Unlike restorePlayerState
      // (login resume, deliberately no autoplay), this honors the remote
      // device's live play/pause/seek state so playback stays in sync across
      // devices/tabs. A message without a song is ignored — an idle device that
      // just opened the app must never clobber a player that is actively
      // producing sound somewhere else.
      applyRemoteState: (state) => {
        const current = get();
        const remoteSong = state.currentSong ? cleanSong(state.currentSong) : null;
        if (!remoteSong) return;

        const songChanged =
          remoteSong.videoId !== (current.currentSong?.videoId ?? null);

        // Track changed (or this is the first real song) — swap the whole
        // player state including the remote's playback position and intent.
        if (songChanged) {
          const isShuffle = state.isShuffle ?? current.isShuffle;
          set({
            currentSong: remoteSong,
            queue: (state.queue ?? []).map(cleanSong),
            currentIndex: state.currentIndex ?? -1,
            currentTime: state.currentTime ?? 0,
            isPlaying: !!state.isPlaying,
            isShuffle,
            repeatMode:
              isShuffle && state.repeatMode === "one"
                ? "none"
                : (state.repeatMode ?? current.repeatMode),
            playbackRate: state.playbackRate ?? current.playbackRate,
            pendingNextIndex: null,
          });
          get().updateMediaSession(remoteSong);
          return;
        }

        // Same on-screen track — apply the live play/pause/seek delta without
        // restarting playback.
        const patch: Partial<PlayerState> = {};
        if (typeof state.isPlaying === "boolean" && state.isPlaying !== current.isPlaying) {
          patch.isPlaying = state.isPlaying;
        }
        if (typeof state.currentTime === "number" && isFinite(state.currentTime)) {
          const target = Math.max(0, state.currentTime);
          if (Math.abs(target - current.currentTime) > 1.5) {
            patch.currentTime = target;
          }
        }
        if (Array.isArray(state.queue)) {
          patch.queue = (state.queue as Song[]).map(cleanSong);
          patch.currentIndex = state.currentIndex ?? current.currentIndex;
        }
        if (typeof state.isShuffle === "boolean" && state.isShuffle !== current.isShuffle) {
          patch.isShuffle = state.isShuffle;
        }
        if (state.repeatMode) {
          const isShuffle = state.isShuffle ?? current.isShuffle;
          patch.repeatMode =
            isShuffle && state.repeatMode === "one" ? "none" : state.repeatMode;
        }

        if (Object.keys(patch).length === 0) return;
        set(patch);

        // Follow a remote seek in the same track immediately.
        if (patch.currentTime !== undefined && typeof current.playerRef?.seekTo === "function") {
          try {
            current.playerRef.seekTo(patch.currentTime);
          } catch {}
        }
      },

      setPlayerRef: (playerRef) => {
        // Wrap seekTo so every seek (user scrub, next()/prev() jumps, remote
        // state sync) announces itself to listeners — the listening-time
        // tracker uses this to never count skipped seconds as listening.
        const wrapped =
          playerRef && typeof playerRef.seekTo === "function"
            ? {
                ...playerRef,
                seekTo: (seconds: number) => {
                  playerRef.seekTo(seconds);
                  get().notifySeek(seconds);
                },
              }
            : playerRef;
        set({ playerRef: wrapped });
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

      notifySeek: () =>
        set((state) => ({ seekCount: state.seekCount + 1 })),

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
      // Rehydrated cache could hold shuffle + repeat-one together; normalize
      // it so the two modes stay mutually exclusive.
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<PlayerState>) };
        if (state.isShuffle && state.repeatMode === "one") {
          state.repeatMode = "none";
        }
        return state as PlayerState;
      },
    }
  )
);
