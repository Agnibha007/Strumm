"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { evaluateCrossfadeTick, CROSSFADE_DURATION_MS } from "web/lib/crossfade";
import { usePlayerStore } from "web/store/usePlayerStore";

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

  const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isFadingRef = useRef<boolean>(false);
  const prevSongIdRef = useRef<string | null>(null);
  const prevIsPlayingRef = useRef<boolean>(false);
  const hasTriggeredCrossfadeRef = useRef<boolean>(false);
  const crossfadeAdvancedRef = useRef<boolean>(false);

  const setPlayerVolume = (volRatio: number) => {
    const targetVal = volRatio * volume;

    if (htmlAudioRef.current && currentSong?.metadata?.audioUrl) {
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
    } else {
      if (htmlAudioRef.current && htmlAudioRef.current.src.startsWith("data:audio")) {
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
    } else {
      if (htmlAudioRef.current && htmlAudioRef.current.src.startsWith("data:audio")) {
        htmlAudioRef.current.pause();
      }
      if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
        try {
          playerInstanceRef.current.pauseVideo();
        } catch (e) {}
      }
    }
  };

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
      if (audio.src && !audio.src.startsWith("data:audio")) {
        audio.removeAttribute("src");
        audio.load();
      }
    };

    const updatePositionState = () => {
      if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
        try {
          // Only sync position state from HTML audio if it's not the silent track
          if (audio.src && audio.src.startsWith("data:audio")) return;
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
      if (audio.src && audio.src.startsWith("data:audio")) return;
      // New track has taken over playback — clear the crossfade guard that was
      // set for the previous track. If it leaked, the next natural `ended`
      // would be swallowed and auto-advance would pause instead of continuing.
      crossfadeAdvancedRef.current = false;
      hasTriggeredCrossfadeRef.current = false;
      setPlaying(true);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
      }
    };
    const onPause = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      setPlaying(false);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
    };
    const onTimeUpdate = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      const curr = audio.currentTime;
      const dur = audio.duration;
      setCurrentTime(curr);
      updatePositionState();

      const crossfadeAction = evaluateCrossfadeTick(curr, dur, hasTriggeredCrossfadeRef.current);
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
    };
    const onDurationChange = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      setDuration(audio.duration || 0);
      updatePositionState();
    };
    const onEnded = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      // Guard against double-advance: if the crossfade mechanism already called
      // next() before this track naturally ended, skip handleTrackEnded.
      if (crossfadeAdvancedRef.current) {
        crossfadeAdvancedRef.current = false;
        return;
      }
      handleTrackEnded();
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
  }, [handleTrackEnded, setCurrentTime, setDuration, setPlaying]);

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
  // This handles hardware media buttons from headphones, keyboards, and lock screen
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    // Update handlers more frequently to ensure they're always ready
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

    // Set up handlers immediately and on mount
    updateMediaSessionHandlers();

    // Update metadata and playback state whenever current song or playing status changes
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

    // Always update playback state based on current isPlaying
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";

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
  }, [currentSong, isPlaying]);



  // Ensure media key routing is always active by keeping audio context alive
  useEffect(() => {
    if (!htmlAudioRef.current) return;

    const silentAudioSrc =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

    // If no song is playing, use silent audio to keep media keys responsive
    if (!currentSong) {
      if (htmlAudioRef.current.src !== silentAudioSrc) {
        htmlAudioRef.current.src = silentAudioSrc;
        htmlAudioRef.current.loop = true;
        htmlAudioRef.current.volume = 0; // Ensure it's inaudible
      }

      // Keep silent audio playing so media keys are routed to us
      if (htmlAudioRef.current.paused) {
        htmlAudioRef.current.play().catch(() => {
          // Autoplay policy restrictions
        });
      }
    }
  }, [currentSong]);

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
      // Play a silent audio track so the host page retains the OS MediaSession keys.
      // This prevents the YouTube iframe from hijacking media hardware buttons.
      const silentAudioSrc = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
      if (htmlAudioRef.current.src !== silentAudioSrc) {
        htmlAudioRef.current.src = silentAudioSrc;
        htmlAudioRef.current.loop = true;
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

  // 4. Watch for play/pause and track transitions from UI (with smooth fade-in/fade-out transitions)
  useEffect(() => {
    const isPodcastVideo = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isPodcastVideo) return;

    const currentSongId = currentSong?.videoId || null;

    if (currentSongId !== prevSongIdRef.current) {
      prevSongIdRef.current = currentSongId;
      prevIsPlayingRef.current = isPlaying;

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
              setPlaying(true);
              usePlayerStore.getState().setPlayerLoading(false);
              setDuration(playerInstanceRef.current.getDuration() || currentSong?.duration || 0);
              startProgressTimer();
            } else if (state === 2) {
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

          const crossfadeAction = evaluateCrossfadeTick(curr, dur, hasTriggeredCrossfadeRef.current);
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
