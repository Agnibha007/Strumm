"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: any;
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
      setCurrentTime(audio.currentTime);
      updatePositionState();
    };
    const onDurationChange = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      setDuration(audio.duration || 0);
      updatePositionState();
    };
    const onEnded = () => {
      if (audio.src && audio.src.startsWith("data:audio")) return;
      handleTrackEnded();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
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

  // Media Session API for Lock-Screen Controls
  useEffect(() => {
    if ("mediaSession" in navigator && currentSong) {
      // Force secure thumbnail to prevent mixed content issues
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

      // Synchronize action handlers to control playback mechanisms
      const updateHandlers = () => {
        navigator.mediaSession.setActionHandler("play", () => {
          if (!isPlaying) {
            usePlayerStore.getState().togglePlay();
          }
        });
        navigator.mediaSession.setActionHandler("pause", () => {
          if (isPlaying) {
            usePlayerStore.getState().togglePlay();
          }
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          const state = usePlayerStore.getState();
          if (state.currentTime > 5) {
            state.playerRef?.seekTo(0);
            state.setCurrentTime(0);
          } else {
            state.prev();
          }
        });
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          usePlayerStore.getState().next();
        });
        navigator.mediaSession.setActionHandler("seekto", (details) => {
          if (details.seekTime !== undefined) {
            const time = details.seekTime;
            usePlayerStore.getState().playerRef?.seekTo(time);
            usePlayerStore.getState().setCurrentTime(time);
          }
        });
        navigator.mediaSession.setActionHandler("seekbackward", (details) => {
          const offset = details.seekOffset || 10;
          const targetTime = Math.max(0, usePlayerStore.getState().currentTime - offset);
          usePlayerStore.getState().playerRef?.seekTo(targetTime);
          usePlayerStore.getState().setCurrentTime(targetTime);
        });
        navigator.mediaSession.setActionHandler("seekforward", (details) => {
          const offset = details.seekOffset || 10;
          const targetTime = Math.min(usePlayerStore.getState().duration, usePlayerStore.getState().currentTime + offset);
          usePlayerStore.getState().playerRef?.seekTo(targetTime);
          usePlayerStore.getState().setCurrentTime(targetTime);
        });
      };

      updateHandlers();
    }

    return () => {
      if ("mediaSession" in navigator) {
        const actions = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const;
        for (const action of actions) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch (e) {}
        }
      }
    };
  }, [currentSong, isPlaying]);

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
  const loadYouTubeAPI = () => {
    if (window.YT && window.YT.Player) {
      if (!playerInstanceRef.current) {
        initPlayer();
      }
      return;
    }

    usePlayerStore.getState().setPlayerLoading(true);
    usePlayerStore.getState().setPlayerError(null);

    // Manually create the player target element outside of React Virtual DOM
    // to prevent React unmount "removeChild" mismatch errors.
    if (containerRef.current && !document.getElementById("strumm-player-iframe")) {
      const playerDiv = document.createElement("div");
      playerDiv.id = "strumm-player-iframe";
      containerRef.current.appendChild(playerDiv);
    }

    window.onYouTubeIframeAPIReady = () => {
      console.log("AudioEngine: onYouTubeIframeAPIReady callback triggered!");
      initPlayer();
    };

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
      console.log("AudioEngine: script element appended to head.");
    } else {
      if (window.YT && window.YT.Player) {
        initPlayer();
      }
    }
  };

  useEffect(() => {
    const isYTSong = currentSong && !currentSong.metadata?.audioUrl;
    if (isYTSong && isPlaying) {
      loadYouTubeAPI();
    }
  }, [currentSong?.videoId, isPlaying]);

  useEffect(() => {
    return () => {
      stopProgressTimer();
      if (playerInstanceRef.current && typeof playerInstanceRef.current.destroy === "function") {
        try {
          playerInstanceRef.current.destroy();
        } catch (e) {
          console.warn("Error destroying YT player:", e);
        }
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, []);

  // 3. Watch for changes in active song and mode
  useEffect(() => {
    if (!htmlAudioRef.current) return;

    const isVideoMode = podcastMode === "video" && currentSong?.metadata?.videoAvailable;

    if (isVideoMode) {
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

      // Do NOT set playerRef here; VideoPlayer component will register its own playerRef when it mounts
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
      const isSrcChanged = htmlAudioRef.current.src !== audioUrl;
      htmlAudioRef.current.preload = audioQuality === "data-saver" ? "none" : audioQuality === "balanced" ? "metadata" : "auto";
      if (isSrcChanged) {
        htmlAudioRef.current.src = audioUrl;
        htmlAudioRef.current.load();
      }
      htmlAudioRef.current.volume = volume;

      // Sync currentTime when switching mode or starting
      const targetTime = usePlayerStore.getState().currentTime;
      if (targetTime > 0 && isFinite(targetTime)) {
        htmlAudioRef.current.currentTime = targetTime;
      }

      if (isPlaying) {
        htmlAudioRef.current.play().catch((e) => console.log("HTML Audio play blocked:", e));
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
          console.log("AudioEngine: Video ID changed from", currentVideoIdRef.current, "to", activeVideoId);
          currentVideoIdRef.current = activeVideoId;
          if (typeof playerInstanceRef.current.loadVideoById === "function") {
            try {
              playerInstanceRef.current.loadVideoById({
                videoId: activeVideoId,
                startSeconds: usePlayerStore.getState().currentTime || 0,
              });
              setPlaying(true);
            } catch (e) {
              console.error("AudioEngine: loadVideoById exception:", e);
            }
          } else {
            console.warn("AudioEngine: player loadVideoById not available yet, queuing up next tick");
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

  // 4. Watch for play/pause toggle from UI
  useEffect(() => {
    const isVideoMode = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isVideoMode) return;

    if (currentSong?.metadata?.audioUrl) {
      if (htmlAudioRef.current) {
        if (isPlaying) {
          htmlAudioRef.current.play().catch(() => {});
        } else {
          htmlAudioRef.current.pause();
        }
      }
    } else {
      // Keep silent audio track in sync with UI play/pause for YouTube songs
      if (htmlAudioRef.current && htmlAudioRef.current.src.startsWith("data:audio")) {
        if (isPlaying) {
          htmlAudioRef.current.play().catch(() => {});
        } else {
          htmlAudioRef.current.pause();
        }
      }

      if (playerInstanceRef.current) {
        try {
          const state = typeof playerInstanceRef.current.getPlayerState === "function"
            ? playerInstanceRef.current.getPlayerState()
            : -1;
          if (isPlaying && state !== 1) {
            if (typeof playerInstanceRef.current.playVideo === "function") {
              playerInstanceRef.current.playVideo();
            }
          } else if (!isPlaying && state === 1) {
            if (typeof playerInstanceRef.current.pauseVideo === "function") {
              playerInstanceRef.current.pauseVideo();
            }
          }
        } catch (e) {}
      }
    }
  }, [isPlaying, podcastMode, currentSong?.metadata?.videoAvailable]);

  // 5. Watch for volume changes from UI
  useEffect(() => {
    const isVideoMode = podcastMode === "video" && currentSong?.metadata?.videoAvailable;
    if (isVideoMode) return;

    if (currentSong?.metadata?.audioUrl) {
      if (htmlAudioRef.current) {
        htmlAudioRef.current.volume = volume;
      }
    } else {
      if (playerInstanceRef.current && typeof playerInstanceRef.current.setVolume === "function") {
        try {
          playerInstanceRef.current.setVolume(Math.round(volume * 100));
        } catch (e) {}
      }
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
    console.log("AudioEngine: initPlayer called. currentSong videoId:", currentSong?.videoId);
    if (!window.YT || !window.YT.Player) {
      console.error("AudioEngine: initPlayer failed because window.YT or window.YT.Player is undefined.");
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
            console.log("AudioEngine: YT Player onReady event triggered!");
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
                console.log("AudioEngine: onReady loading/cueing videoId:", currentSong.videoId);
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
            console.log("AudioEngine: YT Player state changed:", event.data);
            if (currentSong?.metadata?.audioUrl) return; // skip if playing podcast

            const state = event.data;
            if (state === 1) {
              setPlaying(true);
              usePlayerStore.getState().setPlayerLoading(false);
              setDuration(playerInstanceRef.current.getDuration() || currentSong?.duration || 0);
              startProgressTimer();
            } else if (state === 2) {
              setPlaying(false);
              stopProgressTimer();
            } else if (state === 0) {
              stopProgressTimer();
              usePlayerStore.getState().handleTrackEnded();
            }
          },
          onError: (err: any) => {
            if (currentSong?.metadata?.audioUrl) return;
            console.error("AudioEngine: YT Player error:", err);
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
      console.error("AudioEngine: Exception while calling new window.YT.Player:", e);
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
