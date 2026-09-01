"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { evaluateCrossfadeTick, CROSSFADE_DURATION_MS } from "web/lib/crossfade";
import { getCachedDirectAudioUrl, resolveDirectAudioUrl } from "web/lib/direct-audio";
import { usePlayerStore } from "web/store/usePlayerStore";
import {
  getPodcastEpisodeId,
  fetchPodcastProgress,
  savePodcastProgress,
  clearPodcastProgress,
} from "web/lib/podcast-progress";

// A real (digitally silent) audio track. Unlike a muted, sub-second
// data: URI, an element playing this qualifies as a valid Media Session —
// Chrome only routes hardware media keys to elements with >=5s of audio
// that aren't muted, so this keeps play/pause/next on the host page instead
// of letting the cross-origin YouTube iframe hijack them.
const SILENT_AUDIO_SRC = "/silence.wav";

function isSilentAudio(audio: HTMLAudioElement | null | undefined): boolean {
  if (!audio) return false;
  const src = audio.src || "";
  return src.startsWith("data:audio") || src.endsWith(SILENT_AUDIO_SRC);
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: {
      Player: new (
        elementId: string,
        config: {
          height: string | number;
          width: string | number;
          videoId: string;
          playerVars?: Record<string, any>;
          events?: Record<string, (event: any) => void>;
        },
      ) => any;
      PlayerState: {
        UNSTARTED: -1;
        ENDED: 0;
        PLAYING: 1;
        PAUSED: 2;
        BUFFERING: 3;
        CUED: 5;
      };
    };
  }
}

export default function AudioEngine() {
  const pathname = usePathname();
  const {
    currentSong,
    isPlaying,
    volume,
    setPlaying,
    handleTrackEnded,
    setCurrentTime,
    setDuration,
    setPlayerRef,
    podcastMode,
    audioQuality,
    isRadio,
    queue,
    currentIndex,
    fetchMoreRadio,
    sleepTimerEndTime,
    checkSleepTimer,
  } = usePlayerStore();

  const playerInstanceRef = useRef<any>(null);
  const progressTimerRef = useRef<any>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Direct audio URLs resolved for background (lock-screen) playback.
  const directAudioUrlsRef = useRef<Record<string, string>>({});
  // True when a YouTube song has been handed to the host <audio> element
  // because the page is backgrounded (screen locked). Foreground playback
  // stays on the iframe.
  const backgroundModeRef = useRef<boolean>(false);

  const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isFadingRef = useRef<boolean>(false);
  const prevSongIdRef = useRef<string | null>(null);
  const prevIsPlayingRef = useRef<boolean>(false);
  const hasTriggeredCrossfadeRef = useRef<boolean>(false);
  const crossfadeAdvancedRef = useRef<boolean>(false);
  // True between the moment a new track is selected and the moment it actually
  // starts playing. The YouTube player can emit transient PAUSED/ENDED events
  // while swapping videos, which would otherwise stick playback in a paused
  // state right after auto-advance.
  const transitioningRef = useRef<boolean>(false);

  // End-of-track handler that also clears/saves podcast resume position. Used
  // by the HTML audio `ended` handler (and the YouTube ENDED branch) so a
  // finished episode doesn't restart from an old position next time.
  const handlePodcastEnded = useCallback(() => {
    const state = usePlayerStore.getState();
    const episodeId = getPodcastEpisodeId(state.currentSong);
    if (episodeId) {
      const pos = state.currentTime;
      const dur = state.duration || state.currentSong?.duration || 0;
      // Finished (or within 10s of the end) → drop the saved position so the
      // next listen starts fresh. Stopped early → persist the position.
      if (dur > 0 && pos >= dur - 10) {
        clearPodcastProgress(episodeId);
      } else if (pos > 3) {
        savePodcastProgress(episodeId, pos, dur);
      }
    }
    state.handleTrackEnded();
  }, []);

  const setPlayerVolume = (volRatio: number) => {
    const targetVal = volRatio * volume;

    // Apply to the host audio element whenever it holds real audio (a podcast
    // episode, or a direct-audio stream in background mode).
    if (htmlAudioRef.current && (currentSong?.metadata?.audioUrl || !isSilentAudio(htmlAudioRef.current))) {
      htmlAudioRef.current.volume = targetVal;
    }

    if (playerInstanceRef.current && !currentSong?.metadata?.audioUrl && typeof playerInstanceRef.current.setVolume === "function") {
      try {
        playerInstanceRef.current.setVolume(Math.round(targetVal * 100));
      } catch (e) {}
    }
  };

  const fadeVolume = (fromRatio: number, toRatio: number, durationMs: number, onComplete?: () => void) => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }

    isFadingRef.current = true;
    const steps = 15;
    const intervalTime = durationMs / steps;
    let currentStep = 0;

    fadeIntervalRef.current = setInterval(() => {
      currentStep++;
      const ratio = fromRatio + ((toRatio - fromRatio) * (currentStep / steps));
      setPlayerVolume(ratio);

      if (currentStep >= steps) {
        if (fadeIntervalRef.current) {
          clearInterval(fadeIntervalRef.current);
          fadeIntervalRef.current = null;
        }
        isFadingRef.current = false;
        if (onComplete) onComplete();
      }
    }, intervalTime);
  };

  const triggerPlay = () => {
    if (currentSong?.metadata?.audioUrl) {
      if (htmlAudioRef.current) {
        htmlAudioRef.current.play().catch(() => {});
      }
    } else if (backgroundModeRef.current && htmlAudioRef.current && !isSilentAudio(htmlAudioRef.current)) {
      // Background mode — the host <audio> is already on the direct stream.
      htmlAudioRef.current.play().catch(() => {});
    } else {
      if (htmlAudioRef.current && isSilentAudio(htmlAudioRef.current)) {
        htmlAudioRef.current.play().catch(() => {});
      }
      if (playerInstanceRef.current && typeof playerInstanceRef.current.playVideo === "function") {
        try {
          playerInstanceRef.current.playVideo();
        } catch (e) {}
      }
    }
  };

  const triggerPause = () => {
    if (currentSong?.metadata?.audioUrl) {
      if (htmlAudioRef.current) {
        htmlAudioRef.current.pause();
      }
    } else if (backgroundModeRef.current && htmlAudioRef.current && !isSilentAudio(htmlAudioRef.current)) {
      htmlAudioRef.current.pause();
    } else {
      if (htmlAudioRef.current && isSilentAudio(htmlAudioRef.current)) {
        htmlAudioRef.current.pause();
      }
      if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
        try {
          playerInstanceRef.current.pauseVideo();
        } catch (e) {}
      }
    }
  };

  // Switch a YouTube song onto the host <audio> element (background mode).
  // Returns false when there is no resolved direct URL (callers fall back to
  // the iframe, which is the status quo behavior). Memoized with stable deps so
  // its identity never changes between renders — it is a dependency of the
  // pre-resolve effect keyed on the current song.
  const activateBackgroundAudio = useCallback((videoId: string): boolean => {
    const state = usePlayerStore.getState();
    const song = state.currentSong;
    if (!song || song.metadata?.audioUrl) return false; // podcasts already host audio

    const url = getCachedDirectAudioUrl(videoId) || directAudioUrlsRef.current[videoId];
    if (!url) return false;

    if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
      try {
        playerInstanceRef.current.pauseVideo();
      } catch (e) {}
    }

    const audio = htmlAudioRef.current;
    if (!audio) return false;
    try {
      audio.preload = "auto";
      // Read volume fresh from the store so the callback stays stable.
      audio.volume = usePlayerStore.getState().volume;
      audio.src = url;
    } catch (e) {
      return false;
    }

    const seekTo = Math.max(0, state.currentTime);
    const applySeek = () => {
      try {
        audio.currentTime = seekTo;
      } catch (e) {}
    };
    applySeek();
    audio.addEventListener("loadedmetadata", applySeek, { once: true });

    audio.play().catch(() => {});

    // Delegate player controls to the host <audio> until we leave background mode.
    setPlayerRef({
      playVideo: () => {
        if (htmlAudioRef.current) htmlAudioRef.current.play();
      },
      pauseVideo: () => {
        if (htmlAudioRef.current) htmlAudioRef.current.pause();
      },
      seekTo: (sec: number) => {
        if (htmlAudioRef.current) htmlAudioRef.current.currentTime = sec;
      },
      setVolume: (vol: number) => {
        if (htmlAudioRef.current) htmlAudioRef.current.volume = vol / 100;
      },
      setPlaybackRate: (rate: number) => {
        if (htmlAudioRef.current) htmlAudioRef.current.playbackRate = rate;
      },
    });
    return true;
  }, [setPlayerRef]);

  // Enter background mode for the given video and make sure the host <audio>
  // element takes over the direct stream. Commits the background flag UP-FRONT,
  // before any URL is resolved, so a URL that completes while the page is
  // hidden (async yt-dlp extraction, seconds after lock-screen) hands straight
  // over here — previously enterBackground bailed early on a missing URL and
  // the pre-resolve completion path could never fire.
  const ensureBackgroundAudio = useCallback((videoId: string) => {
    if (!backgroundModeRef.current) backgroundModeRef.current = true;

    if (getCachedDirectAudioUrl(videoId) || directAudioUrlsRef.current[videoId]) {
      activateBackgroundAudio(videoId);
      return;
    }

    resolveDirectAudioUrl(videoId).then((url) => {
      if (!url || !backgroundModeRef.current) return;
      directAudioUrlsRef.current[videoId] = url;
      const state = usePlayerStore.getState();
      if (state.isPlaying && state.currentSong?.videoId === videoId) {
        activateBackgroundAudio(videoId);
      }
    });
  }, [activateBackgroundAudio]);

  useEffect(() => {
    return () => {
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }
    };
  }, []);

  // Auto-fetch more radio tracks when near end of queue
  useEffect(() => {
    if (!isRadio || queue.length === 0) return;
    const remaining = queue.length - currentIndex - 1;
    if (remaining <= 3) {
      fetchMoreRadio();
    }
  }, [currentIndex, isRadio, queue.length, fetchMoreRadio]);

  // Sleep Timer Check
  useEffect(() => {
    if (!sleepTimerEndTime || !isPlaying) return;

    const sleepTimerInterval = setInterval(() => {
      checkSleepTimer();
    }, 1000); // Check every second

    return () => clearInterval(sleepTimerInterval);
  }, [sleepTimerEndTime, isPlaying, checkSleepTimer]);

  // 1. Setup HTML Audio elements and events
  useEffect(() => {
    htmlAudioRef.current = new Audio();
    const audio = htmlAudioRef.current;

    const handleAudioError = () => {
      const mediaError = audio.error;
      if (mediaError) {
        console.warn(
          `AudioEngine: Media error — code=${mediaError.code}, message="${mediaError.message}"`,
        );
      }
      // Reset src so the element isn't stuck in an error state
      if (audio.src && !isSilentAudio(audio)) {
        audio.removeAttribute("src");
        audio.load();
      }
    };

    const updatePositionState = () => {
      if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
        try {
          // Only sync position state from HTML audio if it's not the silent track
          if (audio.src && isSilentAudio(audio)) return;
          const duration = audio.duration;
          const position = audio.currentTime;
          if (isFinite(duration) && isFinite(position) && duration > 0) {
            navigator.mediaSession.setPositionState({
              duration: duration,
              position: position,
              playbackRate: audio.playbackRate || 1.0
            });
          }
        } catch (e) {}
      }
    };

    const onPlay = () => {
      if (audio.src && isSilentAudio(audio)) return;
      // New track has taken over playback — clear the crossfade guard that was
      // set for the previous track. If it leaked, the next natural `ended`
      // would be swallowed and auto-advance would pause instead of continuing.
      crossfadeAdvancedRef.current = false;
      hasTriggeredCrossfadeRef.current = false;
      transitioningRef.current = false;
      setPlaying(true);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
      }
    };
    const onPause = () => {
      if (audio.src && isSilentAudio(audio)) return;
      // Ignore pause events fired while the engine is swapping tracks — the
      // element for the old track is being torn down and the new one is loading.
      if (transitioningRef.current) return;
      setPlaying(false);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
    };
    const onTimeUpdate = () => {
      if (audio.src && isSilentAudio(audio)) return;
      const curr = audio.currentTime;
      const dur = audio.duration;
      setCurrentTime(curr);
      updatePositionState();

      // Skip crossfade evaluation while swapping tracks so the leaked
      // "fade triggered" flag from the previous track can't cancel the fade-in.
      if (!transitioningRef.current) {
        const crossfadeAction = evaluateCrossfadeTick(
          curr,
          dur,
          hasTriggeredCrossfadeRef.current,
          usePlayerStore.getState().repeatMode
        );
        if (crossfadeAction === "start-fade") {
          hasTriggeredCrossfadeRef.current = true;
          fadeVolume(1, 0, CROSSFADE_DURATION_MS, () => {
            crossfadeAdvancedRef.current = true;
            usePlayerStore.getState().next();
          });
        } else if (crossfadeAction === "cancel-fade") {
          hasTriggeredCrossfadeRef.current = false;
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
            fadeIntervalRef.current = null;
          }
          isFadingRef.current = false;
          setPlayerVolume(1.0);
        }
      }
    };
    const onDurationChange = () => {
      if (audio.src && isSilentAudio(audio)) return;
      setDuration(audio.duration || 0);
      updatePositionState();
    };
    const onEnded = () => {
      if (audio.src && isSilentAudio(audio)) return;
      // Guard against double-advance: if the crossfade mechanism already called
      // next() before this track naturally ended, skip handleTrackEnded.
      if (crossfadeAdvancedRef.current) {
        crossfadeAdvancedRef.current = false;
        return;
      }
      handlePodcastEnded();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", handleAudioError);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", handleAudioError);
      audio.pause();
    };
  }, [handlePodcastEnded, handleTrackEnded, setCurrentTime, setDuration, setPlaying]);

  // Global Spacebar Play/Pause Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        usePlayerStore.getState().togglePlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Media Session API for Lock-Screen Controls and Media Keys
  // This handles hardware media buttons from headphones, keyboards, and lock screen.
  // Handlers are registered ONCE on mount (deps []) so they are never torn down
  // and re-created on every play/pause/track change — that gap is when hardware
  // media keys silently stop working.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const updateMediaSessionHandlers = () => {
      try {
        const ms = navigator.mediaSession;

        // Set up action handlers for all media controls
        ms.setActionHandler("play", () => {
          const state = usePlayerStore.getState();
          if (!state.isPlaying) {
            state.togglePlay();
          }
        });

        ms.setActionHandler("pause", () => {
          const state = usePlayerStore.getState();
          if (state.isPlaying) {
            state.togglePlay();
          }
        });

        ms.setActionHandler("previoustrack", () => {
          const state = usePlayerStore.getState();
          if (state.currentTime > 5) {
            state.playerRef?.seekTo(0);
            state.setCurrentTime(0);
          } else {
            state.prev();
          }
        });

        ms.setActionHandler("nexttrack", () => {
          usePlayerStore.getState().next();
        });

        ms.setActionHandler("seekto", (details) => {
          if (details.seekTime !== undefined) {
            const state = usePlayerStore.getState();
            state.playerRef?.seekTo(details.seekTime);
            state.setCurrentTime(details.seekTime);
          }
        });

        ms.setActionHandler("seekbackward", (details) => {
          const offset = details.seekOffset || 10;
          const state = usePlayerStore.getState();
          const targetTime = Math.max(0, state.currentTime - offset);
          state.playerRef?.seekTo(targetTime);
          state.setCurrentTime(targetTime);
        });

        ms.setActionHandler("seekforward", (details) => {
          const offset = details.seekOffset || 10;
          const state = usePlayerStore.getState();
          const targetTime = Math.min(state.duration, state.currentTime + offset);
          state.playerRef?.seekTo(targetTime);
          state.setCurrentTime(targetTime);
        });

        ms.setActionHandler("skipad", () => {
          usePlayerStore.getState().next();
        });

        ms.setActionHandler("stop", () => {
          const state = usePlayerStore.getState();
          if (state.isPlaying) {
            state.togglePlay();
          }
        });
      } catch (error) {
        // Some actions may not be supported on all platforms
      }
    };

    updateMediaSessionHandlers();

    // Cleanup handlers on unmount
    return () => {
      if ("mediaSession" in navigator) {
        const actions = [
          "play",
          "pause",
          "previoustrack",
          "nexttrack",
          "seekto",
          "seekbackward",
          "seekforward",
          "skipad",
          "stop",
        ] as const;
        
        for (const action of actions) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch (e) {
            // Handler may not be supported
          }
        }
      }
    };
  }, []);

  // Keep lock-screen metadata and playback state in sync with the UI.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    if (currentSong) {
      let secureArtwork = currentSong.thumbnail;
      if (secureArtwork && secureArtwork.startsWith("http://")) {
        secureArtwork = secureArtwork.replace("http://", "https://");
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist,
        album: currentSong.metadata?.album || "Strumm",
        artwork: [
          { src: secureArtwork || "", sizes: "96x96", type: "image/jpeg" },
          { src: secureArtwork || "", sizes: "256x256", type: "image/jpeg" },
          { src: secureArtwork || "", sizes: "512x512", type: "image/jpeg" },
        ],
      });
    } else {
      navigator.mediaSession.metadata = null;
    }

    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [currentSong, isPlaying]);

  // Embedded YouTube players can auto-pause when the tab is hidden. Since that
  // pause isn't user intent (we ignore it in onStateChange), resume the player
  // the moment the user comes back to the tab.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const state = usePlayerStore.getState();
      if (!state.isPlaying) return;
      const yt = playerInstanceRef.current;
      if (!yt || typeof yt.getPlayerState !== "function") return;
      try {
        if (yt.getPlayerState() === 2) yt.playVideo();
      } catch (e) {
        // Ignore transient errors while the player is (re)initializing
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Ensure media key routing is always active by keeping audio context alive
  useEffect(() => {
    if (!htmlAudioRef.current) return;

    const silentAudioSrc = SILENT_AUDIO_SRC;

    // If no song is playing, use silent audio to keep media keys responsive
    if (!currentSong) {
      if (!isSilentAudio(htmlAudioRef.current)) {
        htmlAudioRef.current.src = silentAudioSrc;
        htmlAudioRef.current.loop = true;
        // The file itself is digitally silent, so normal volume stays inaudible —
        // but keeps the element eligible as a Media Session (muted/volume-0
        // elements are ignored for hardware key routing).
        htmlAudioRef.current.volume = 1.0;
      }

      // Keep silent audio playing so media keys are routed to us
      if (htmlAudioRef.current.paused) {
        htmlAudioRef.current.play().catch(() => {
          // Autoplay policy restrictions
        });
      }
    }
  }, [currentSong]);

  // Keep the screen (and the tab's CPU budget) awake while playback is active.
  // Prevents the device locking early while the user is listening and stops
  // background throttling of the player. Re-acquired automatically whenever
  // the tab regains focus / visibility.
  useEffect(() => {
    let wakeLock: any = null;
    const isSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;

    if (!isSupported) return;

    const acquire = async () => {
      const state = usePlayerStore.getState();
      if (!state.isPlaying) return;
      try {
        wakeLock = await (navigator as any).wakeLock.request("screen");
      } catch (e) {
        // Wake Lock may be denied (no user gesture, battery saver) — ignore.
        wakeLock = null;
      }
    };

    const release = () => {
      if (wakeLock) {
        try {
          wakeLock.release().catch(() => {});
        } catch (e) {}
        wakeLock = null;
      }
    };

    if (isPlaying) {
      acquire();
    } else {
      release();
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        acquire();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      release();
    };
  }, [isPlaying]);

  // Pre-resolve a direct audio URL for the current YouTube song so switching
  // to background (lock-screen) playback is instant. This never affects
  // foreground playback — the iframe keeps playing until the screen locks.
  useEffect(() => {
    const videoId = currentSong?.videoId;
    if (!videoId || currentSong?.metadata?.audioUrl) return;
    if (getCachedDirectAudioUrl(videoId) || directAudioUrlsRef.current[videoId]) return;

    let cancelled = false;
    resolveDirectAudioUrl(videoId).then((url) => {
      if (cancelled || !url) return;
      directAudioUrlsRef.current[videoId] = url;
      // The screen locked while extraction was in flight — take over now.
      const state = usePlayerStore.getState();
      if (backgroundModeRef.current && state.currentSong?.videoId === videoId && state.isPlaying) {
        activateBackgroundAudio(videoId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentSong?.videoId, currentSong?.metadata?.audioUrl, activateBackgroundAudio]);

  // Pre-warm direct audio URLs for the next few queue tracks so a lock-screen
  // handover is already resolved by the time a song starts (extraction via the
  // API can take seconds). Cheap — results are cached, requests are deduped.
  useEffect(() => {
    const upcoming: string[] = [];
    const seen = new Set<string>();
    for (let k = currentIndex + 1; k < queue.length && upcoming.length < 2; k++) {
      const v = queue[k]?.videoId;
      if (!v || seen.has(v) || getCachedDirectAudioUrl(v)) continue;
      seen.add(v);
      upcoming.push(v);
    }
    if (upcoming.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const v of upcoming) {
        if (cancelled) return;
        try {
          const url = await resolveDirectAudioUrl(v);
          if (url && !cancelled) directAudioUrlsRef.current[v] = url;
        } catch (e) {
          // Extraction failed for this track — skip and try the next.
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentIndex, queue, currentSong?.videoId]);

  // Hybrid background mode: mobile browsers suspend YouTube iframes (and the
  // whole tab's audio) when the screen locks, but keep a host <audio> element
  // alive. When the page is backgrounded, hand the current YouTube song to the
  // <audio> element (direct audio URL); on return to the foreground, stop the
  // audio and resume the iframe where it left off.
  useEffect(() => {
    const enterBackground = () => {
      if (backgroundModeRef.current) return;
      const state = usePlayerStore.getState();
      const song = state.currentSong;
      if (!state.isPlaying || !song || song.metadata?.audioUrl) return;
      const videoId = song.videoId;
      if (!videoId) return;
      ensureBackgroundAudio(videoId);
    };

    const leaveBackground = () => {
      if (!backgroundModeRef.current) return;
      backgroundModeRef.current = false;

      const state = usePlayerStore.getState();
      const audio = htmlAudioRef.current;
      const song = state.currentSong;

      if (audio && !isSilentAudio(audio)) {
        try {
          audio.pause();
        } catch (e) {}
        try {
          audio.removeAttribute("src");
          audio.load();
        } catch (e) {}
      }

      // Restore the silent loop track so the host page stays the OS media
      // session owner now that the audible source is the YouTube iframe again.
      if (song && !song.metadata?.audioUrl && audio) {
        try {
          audio.src = SILENT_AUDIO_SRC;
          audio.loop = true;
          audio.volume = 1.0;
        } catch (e) {}
        if (state.isPlaying) audio.play().catch(() => {});
      }

      if (!state.isPlaying) return;
      const yt = playerInstanceRef.current;
      if (!yt || typeof yt.getPlayerState !== "function") return;
      try {
        if (yt.getPlayerState() === 2) yt.playVideo();
        const ct = state.currentTime;
        if (ct > 0 && typeof yt.seekTo === "function") yt.seekTo(ct, true);
      } catch (e) {
        // Player may still be (re)initializing — the existing
        // visibilitychange handler retries when the tab regains focus.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") enterBackground();
      else leaveBackground();
    };
    // Safari fires pagehide (rather than visibilitychange) when the tab is
    // backgrounded on some iOS versions — same handling.
    const onPageHide = () => enterBackground();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      leaveBackground();
    };
  }, [ensureBackgroundAudio]);

  // Resilience net: while the page is backgrounded some OSes suspend the host
  // <audio> element. Re-asserting play() every few seconds brings it back
  // without user input whenever throttling allows a timer tick.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!backgroundModeRef.current) return;
      const state = usePlayerStore.getState();
      if (!state.isPlaying) return;
      const audio = htmlAudioRef.current;
      if (!audio || !audio.src || isSilentAudio(audio) || audio.error) return;
      if (audio.paused && audio.readyState >= 2) {
        try {
          audio.play().catch(() => {});
        } catch (e) {}
      }
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Synchronize Media Session position state with actual playback position
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentSong) return;

    const syncPositionState = () => {
      try {
        const state = usePlayerStore.getState();
        if (
          typeof navigator.mediaSession.setPositionState === "function" &&
          isFinite(state.duration) &&
          state.duration > 0
        ) {
          navigator.mediaSession.setPositionState({
            duration: state.duration,
            position: state.currentTime,
            playbackRate: 1.0,
          });
        }
      } catch (e) {
        // Position state update not supported
      }
    };

    syncPositionState();
    const interval = setInterval(syncPositionState, 500);

    return () => clearInterval(interval);
  }, [currentSong]);

  // Dynamically update document title based on active track and playback state
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (currentSong) {
        const prefix = isPlaying ? "▶ " : "";
        document.title = `${prefix}${currentSong.title} - ${currentSong.artist} | Strumm`;
      } else {
        document.title = "Strumm - Where your music lives.";
      }
    }
  }, [currentSong, isPlaying, pathname]);

  // 2. Lazy Load YouTube API
  useEffect(() => {
    const isYTSong = currentSong && !currentSong.metadata?.audioUrl;
    if (!isYTSong || !isPlaying) return;

    usePlayerStore.getState().setPlayerLoading(true);
    usePlayerStore.getState().setPlayerError(null);

    // Manually create the player target element
    if (containerRef.current && !document.getElementById("strumm-player-iframe")) {
      const playerDiv = document.createElement("div");
      playerDiv.id = "strumm-player-iframe";
      containerRef.current.appendChild(playerDiv);
    }

    // Try immediately if API is already loaded — but only if player doesn't already exist.
    // Calling initPlayer() again without destroying the old player orphans the first player
    // and the second won't be ready in time for loadVideoById.
    if (window.YT && window.YT.Player) {
      if (!playerInstanceRef.current) {
        initPlayer();
      } else {
        // Player already exists — clear the loading state we set above.
        // Otherwise, subsequent songs will show "Loading..." forever.
        usePlayerStore.getState().setPlayerLoading(false);
      }
      return;
    }

    const existingCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof existingCallback === "function") {
        existingCallback();
      }
      if (!playerInstanceRef.current) {
        initPlayer();
      }
    };

    // Only load the script if not already loading
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = () => {
        usePlayerStore.getState().setPlayerLoading(false);
        usePlayerStore.getState().setPlayerError("Failed to load player engine. Retrying...");
        setTimeout(() => {
          if (!window.YT) {
            const retryTag = document.createElement("script");
            retryTag.src = "https://www.youtube.com/iframe_api";
            document.head.appendChild(retryTag);
          }
        }, 3000);
      };
      document.head.appendChild(tag);
    } else {
      // Script already loading — poll for API
      const pollInterval = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(pollInterval);
          if (!playerInstanceRef.current) {
            initPlayer();
          }
        }
      }, 200);
      setTimeout(() => clearInterval(pollInterval), 10_000);
    }
  }, [currentSong?.videoId, isPlaying]);

  useEffect(() => {
    return () => {
      stopProgressTimer();
      if (playerInstanceRef.current && typeof playerInstanceRef.current.destroy === "function") {
        try {
          playerInstanceRef.current.destroy();
        } catch (e) {
          // Silently ignore cleanup errors
        }
      }
      // No need to manually remove children — the container div has no React children
      // and React removes it from the DOM on unmount. The browser GC handles all
      // descendants (including the YouTube iframe and any script tags).
    };
  }, []);

  // 3. Watch for changes in active song and mode
  useEffect(() => {
    if (!htmlAudioRef.current) return;

    const isPodcastVideo = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isPodcastVideo) {
      // Pause YouTube player
      if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
        try {
          playerInstanceRef.current.pauseVideo();
        } catch (e) {}
      }
      stopProgressTimer();

      // Pause HTML Audio player
      try {
        htmlAudioRef.current.pause();
      } catch (e) {}

      return;
    }

    if (currentSong?.metadata?.audioUrl) {
      // A. Podcast / HTML audio file
      // Pause YouTube player
      if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
        try {
          playerInstanceRef.current.pauseVideo();
        } catch (e) {}
      }
      stopProgressTimer();

      const audioUrl =
        currentSong.metadata.audioVariants?.[audioQuality] ||
        currentSong.metadata.audioVariants?.high ||
        currentSong.metadata.audioUrl ||
        "";

      // Guard: skip if audio URL is empty to prevent NotSupportedError
      if (!audioUrl) {
        console.warn("AudioEngine: Cannot play podcast episode — no audio URL available.");
        setPlayerRef({
          playVideo: () => {},
          pauseVideo: () => {},
          seekTo: () => {},
          setVolume: () => {},
          setPlaybackRate: () => {},
        });
        return;
      }

      const isSrcChanged = htmlAudioRef.current.src !== audioUrl;
      htmlAudioRef.current.preload = audioQuality === "data-saver" ? "none" : audioQuality === "balanced" ? "metadata" : "auto";
      if (isSrcChanged) {
        try {
          htmlAudioRef.current.src = audioUrl;
          htmlAudioRef.current.load();
        } catch (e) {
          console.warn("AudioEngine: Failed to load audio source:", e);
        }
      }
      htmlAudioRef.current.volume = volume;

      // Sync currentTime when switching mode or starting
      const targetTime = usePlayerStore.getState().currentTime;
      if (targetTime > 0 && isFinite(targetTime)) {
        htmlAudioRef.current.currentTime = targetTime;
      }

      if (isPlaying) {
        htmlAudioRef.current.play().catch(() => {
          // Silently ignore autoplay policy restrictions
        });
      } else {
        htmlAudioRef.current.pause();
      }

      // Set delegate to control HTML Audio
      setPlayerRef({
        playVideo: () => htmlAudioRef.current?.play(),
        pauseVideo: () => htmlAudioRef.current?.pause(),
        seekTo: (sec: number) => {
          if (htmlAudioRef.current) htmlAudioRef.current.currentTime = sec;
        },
        setVolume: (vol: number) => {
          if (htmlAudioRef.current) htmlAudioRef.current.volume = vol / 100;
        },
        setPlaybackRate: (rate: number) => {
          if (htmlAudioRef.current) htmlAudioRef.current.playbackRate = rate;
        },
      });
    } else {
      // B. YouTube song
      // If the page is backgrounded (screen locked), keep playing through the
      // host <audio> element on its resolved direct stream instead of the
      // iframe, which mobile OSes suspend while backgrounded. When the direct
      // URL isn't ready yet (fresh extraction) ensureBackgroundAudio commits
      // the takeover request and fires the moment the URL lands.
      if (backgroundModeRef.current && currentSong?.videoId) {
        ensureBackgroundAudio(currentSong.videoId);
        return;
      }
      // Play a silent audio track so the host page retains the OS MediaSession keys.
      // This prevents the YouTube iframe from hijacking media hardware buttons.
      const silentAudioSrc = SILENT_AUDIO_SRC;
      if (!isSilentAudio(htmlAudioRef.current)) {
        htmlAudioRef.current.src = silentAudioSrc;
        htmlAudioRef.current.loop = true;
        // Normal volume (the file is digitally silent) so the element counts
        // as an active Media Session for hardware key routing.
        htmlAudioRef.current.volume = 1.0;
      }
      if (isPlaying) {
        htmlAudioRef.current.play().catch(() => {});
      } else {
        htmlAudioRef.current.pause();
      }

      if (playerInstanceRef.current && currentSong?.videoId) {
        const activeVideoId = currentSong.videoId;
        if (currentVideoIdRef.current !== activeVideoId) {
          currentVideoIdRef.current = activeVideoId;
          if (typeof playerInstanceRef.current.loadVideoById === "function") {
            try {
              playerInstanceRef.current.loadVideoById({
                videoId: activeVideoId,
                startSeconds: usePlayerStore.getState().currentTime || 0,
              });
              setPlaying(true);
            } catch (e) {
              // Silently ignore video loading errors
            }
          } else {
            // loadVideoById not available yet, will retry on next sync
          }
        } else {
          if (isPlaying) {
            if (typeof playerInstanceRef.current.playVideo === "function") {
              playerInstanceRef.current.playVideo();
            }
          } else {
            if (typeof playerInstanceRef.current.pauseVideo === "function") {
              playerInstanceRef.current.pauseVideo();
            }
          }
        }
      }

      // Re-register YouTube controller
      if (playerInstanceRef.current && typeof playerInstanceRef.current.playVideo === "function") {
        const yt = playerInstanceRef.current;
        setPlayerRef({
          playVideo: () => {
            if (typeof yt.playVideo === "function") yt.playVideo();
          },
          pauseVideo: () => {
            if (typeof yt.pauseVideo === "function") yt.pauseVideo();
          },
          seekTo: (sec: number) => {
            if (typeof yt.seekTo === "function") yt.seekTo(sec, true);
          },
          setVolume: (vol: number) => {
            if (typeof yt.setVolume === "function") yt.setVolume(vol);
          },
          setPlaybackRate: (rate: number) => {
            if (typeof yt.setPlaybackRate === "function") yt.setPlaybackRate(rate);
          },
          setPlaybackQuality: (quality: string) => {
            if (typeof yt.setPlaybackQuality === "function") yt.setPlaybackQuality(quality);
          },
        });
      }
    }
  }, [currentSong?.videoId, currentSong?.metadata?.audioUrl, podcastMode, audioQuality]);

  // Podcast resume: auto-seek to the saved position and persist progress
  // periodically (and when leaving the episode). Only meaningful for HTML
  // audio playback, which is how podcast episodes actually play.
  useEffect(() => {
    const episodeId = getPodcastEpisodeId(currentSong);
    if (!episodeId) return;

    let cancelled = false;
    let saveTimer: ReturnType<typeof setInterval> | null = null;

    const saveNow = () => {
      const state = usePlayerStore.getState();
      const pos = state.currentTime;
      const dur = state.duration || currentSong?.duration || 0;
      if (pos > 3) savePodcastProgress(episodeId, pos, dur);
    };

    // 1. Auto-resume: fetch the saved position and seek once the audio for
    // this episode has metadata loaded.
    (async () => {
      const { positionSeconds } = await fetchPodcastProgress(episodeId);
      if (cancelled || !positionSeconds || positionSeconds <= 0) return;

      setCurrentTime(positionSeconds);

      const audio = htmlAudioRef.current;
      if (!audio) return;

      let applied = false;
      const applySeek = () => {
        if (cancelled || applied) return;
        // Don't yank playback backwards if the user already got past the
        // saved position (e.g. a slow fetch while the episode was playing).
        if (audio.currentTime > positionSeconds + 2) {
          applied = true;
          return;
        }
        try {
          audio.currentTime = positionSeconds;
          applied = true;
        } catch {
          // Seek may fail before metadata is available; retries will re-apply.
        }
      };

      if (audio.readyState >= 1) {
        applySeek();
      } else {
        audio.addEventListener("loadedmetadata", applySeek);
        audio.addEventListener("canplay", applySeek);
        const retry = setInterval(applySeek, 500);
        setTimeout(() => {
          clearInterval(retry);
          audio.removeEventListener("loadedmetadata", applySeek);
          audio.removeEventListener("canplay", applySeek);
        }, 6000);
      }
    })();

    // 2. Periodic save while the episode is active.
    saveTimer = setInterval(saveNow, 12000);

    // 3. Save when the tab is hidden (closing / switching away mid-episode).
    const saveOnHidden = () => {
      if (document.visibilityState === "hidden") saveNow();
    };
    document.addEventListener("visibilitychange", saveOnHidden);

    return () => {
      cancelled = true;
      if (saveTimer) clearInterval(saveTimer);
      document.removeEventListener("visibilitychange", saveOnHidden);
      // Final save of the position when the user switches episodes.
      saveNow();
    };
  }, [currentSong?.videoId, setCurrentTime]);

  // 4. Watch for play/pause and track transitions from UI (with smooth fade-in/fade-out transitions)
  useEffect(() => {
    const isPodcastVideo = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isPodcastVideo) return;

    const currentSongId = currentSong?.videoId || null;

    if (currentSongId !== prevSongIdRef.current) {
      prevSongIdRef.current = currentSongId;
      prevIsPlayingRef.current = isPlaying;

      // Mark the swap in progress so transient player events (PAUSED/ENDED)
      // fired while the new video loads don't get misread as user intent.
      transitioningRef.current = true;

      setPlayerVolume(0);
      if (isPlaying) {
        triggerPlay();
        fadeVolume(0, 1, 800); // Smooth track change fade-in
      } else {
        triggerPause();
      }
    } else if (isPlaying !== prevIsPlayingRef.current) {
      prevIsPlayingRef.current = isPlaying;

      if (isPlaying) {
        setPlayerVolume(0);
        triggerPlay();
        fadeVolume(0, 1, 600); // Smooth play resume fade-in
      } else {
        fadeVolume(1, 0, 500, () => {
          triggerPause();
        });
      }
    }
  }, [isPlaying, currentSong?.videoId, podcastMode, currentSong?.metadata?.videoAvailable]);

  // 5. Watch for volume changes from UI
  useEffect(() => {
    const isPodcastVideo = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isPodcastVideo) return;

    if (!isFadingRef.current) {
      setPlayerVolume(1.0);
    }
  }, [volume, podcastMode, currentSong?.metadata?.videoAvailable]);

  useEffect(() => {
    const qualityMap = {
      "data-saver": "small",
      balanced: "medium",
      high: "hd720",
    } as const;

    if (playerInstanceRef.current && typeof playerInstanceRef.current.setPlaybackQuality === "function") {
      try {
        playerInstanceRef.current.setPlaybackQuality(qualityMap[audioQuality]);
      } catch (e) {}
    }

    if (htmlAudioRef.current) {
      htmlAudioRef.current.preload = audioQuality === "data-saver" ? "none" : audioQuality === "balanced" ? "metadata" : "auto";
    }
  }, [audioQuality]);

  const initPlayer = () => {
    if (!window.YT || !window.YT.Player) {
      return;
    }

    usePlayerStore.getState().setPlayerLoading(true);
    usePlayerStore.getState().setPlayerError(null);

    try {
      playerInstanceRef.current = new window.YT.Player("strumm-player-iframe", {
        height: "250",
        width: "250",
        videoId: currentSong?.metadata?.audioUrl ? "" : (currentSong?.videoId || ""),
        playerVars: {
          autoplay: isPlaying && !currentSong?.metadata?.audioUrl ? 1 : 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          showinfo: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: (event: any) => {
            usePlayerStore.getState().setPlayerLoading(false);
            const ytPlayer = event.target;
            if (!currentSong?.metadata?.audioUrl) {
              setPlayerRef({
                playVideo: () => ytPlayer.playVideo(),
                pauseVideo: () => ytPlayer.pauseVideo(),
                seekTo: (sec: number) => ytPlayer.seekTo(sec, true),
                setVolume: (vol: number) => ytPlayer.setVolume(vol),
                setPlaybackRate: (rate: number) => ytPlayer.setPlaybackRate(rate),
                setPlaybackQuality: (quality: string) => {
                  if (typeof ytPlayer.setPlaybackQuality === "function") ytPlayer.setPlaybackQuality(quality);
                },
              });
              if (typeof ytPlayer.setPlaybackQuality === "function") {
                const qualityMap = {
                  "data-saver": "small",
                  balanced: "medium",
                  high: "hd720",
                } as const;
                ytPlayer.setPlaybackQuality(qualityMap[audioQuality]);
              }
              ytPlayer.setVolume(Math.round(volume * 100));
              if (currentSong?.videoId) {
                currentVideoIdRef.current = currentSong.videoId;
                const targetStart = usePlayerStore.getState().currentTime || 0;
                if (isPlaying) {
                  ytPlayer.playVideo();
                  if (targetStart > 0) {
                    ytPlayer.seekTo(targetStart, true);
                  }
                } else {
                  ytPlayer.cueVideoById({
                    videoId: currentSong.videoId,
                    startSeconds: targetStart,
                  });
                }
              }
            }
          },
          onStateChange: (event: any) => {
            if (currentSong?.metadata?.audioUrl) return; // skip if playing podcast

            const state = event.data;
            if (state === 1) {
              // The new song has taken over — the crossfade guard for the
              // *previous* track is no longer needed. If we kept it, the leaked
              // flag would suppress handleTrackEnded() when THIS track finishes,
              // causing auto-advance to pause instead of continuing.
              crossfadeAdvancedRef.current = false;
              hasTriggeredCrossfadeRef.current = false;
              transitioningRef.current = false;
              setPlaying(true);
              usePlayerStore.getState().setPlayerLoading(false);
              setDuration(playerInstanceRef.current.getDuration() || currentSong?.duration || 0);
              startProgressTimer();
            } else if (state === 2) {
              // Ignore transient PAUSED events fired while the player is swapping
              // to the next track — otherwise the new song would stick paused
              // right after auto-advance.
              if (transitioningRef.current) return;
              // Ignore pauses the browser triggers when the tab is hidden (the
              // embedded player is backgrounded). Treating it as user intent would
              // flip the UI to "paused" for no reason; the visibilitychange
              // handler resumes playback when the user returns.
              if (document.hidden) return;
              setPlaying(false);
              stopProgressTimer();
            } else if (state === 0) {
              stopProgressTimer();
              // Guard against double-advance: if the crossfade mechanism already
              // called next() before this track naturally ended, skip
              // handleTrackEnded. The ref is set right before next() is called
              // in the crossfade callback.
              if (crossfadeAdvancedRef.current) {
                crossfadeAdvancedRef.current = false;
                return;
              }
              usePlayerStore.getState().handleTrackEnded();
            }
          },
          onError: (err: any) => {
            if (currentSong?.metadata?.audioUrl) return;
            usePlayerStore.getState().setPlayerLoading(false);
            usePlayerStore.getState().setPlayerError("Playback failed or restricted. Skipping...");
            stopProgressTimer();
            setTimeout(() => {
              usePlayerStore.getState().next();
            }, 2000);
          },
        },
      });
    } catch (e) {
      usePlayerStore.getState().setPlayerLoading(false);
      usePlayerStore.getState().setPlayerError("Failed to initialize player.");
    }
  };

  const startProgressTimer = () => {
    stopProgressTimer();
    progressTimerRef.current = setInterval(() => {
      if (
        playerInstanceRef.current &&
        typeof playerInstanceRef.current.getCurrentTime === "function" &&
        typeof playerInstanceRef.current.getDuration === "function"
      ) {
        try {
          const curr = playerInstanceRef.current.getCurrentTime();
          const dur = playerInstanceRef.current.getDuration();
          setCurrentTime(curr);
          if (dur !== undefined && dur !== null && !isNaN(dur)) setDuration(dur);

          // Skip crossfade evaluation while swapping tracks so the leaked
          // "fade triggered" flag from the previous track can't cancel the
          // new track's fade-in.
          if (!transitioningRef.current) {
            const crossfadeAction = evaluateCrossfadeTick(
              curr,
              dur,
              hasTriggeredCrossfadeRef.current,
              usePlayerStore.getState().repeatMode
            );
            if (crossfadeAction === "start-fade") {
              hasTriggeredCrossfadeRef.current = true;
              fadeVolume(1, 0, CROSSFADE_DURATION_MS, () => {
                crossfadeAdvancedRef.current = true;
                usePlayerStore.getState().next();
              });
            } else if (crossfadeAction === "cancel-fade") {
              hasTriggeredCrossfadeRef.current = false;
              if (fadeIntervalRef.current) {
                clearInterval(fadeIntervalRef.current);
                fadeIntervalRef.current = null;
              }
              isFadingRef.current = false;
              setPlayerVolume(1.0);
            }
          }
          
          // Sync MediaSession position state for YT Player
          if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
            if (isFinite(dur) && isFinite(curr) && dur > 0) {
              const playbackRate = typeof playerInstanceRef.current.getPlaybackRate === "function"
                ? playerInstanceRef.current.getPlaybackRate()
                : 1.0;
              navigator.mediaSession.setPositionState({
                duration: dur,
                position: curr,
                playbackRate: playbackRate || 1.0
              });
            }
          }
        } catch (e) {}
      }
    }, 250);
  };

  const stopProgressTimer = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  return (
    <div 
      ref={containerRef} 
      className="fixed pointer-events-none w-[300px] h-[300px] top-0 left-0 -z-50" 
    />
  );
}
