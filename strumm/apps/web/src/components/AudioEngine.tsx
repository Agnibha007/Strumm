"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: any;
  }
}

export default function AudioEngine() {
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
  } = usePlayerStore();

  const playerInstanceRef = useRef<any>(null);
  const progressTimerRef = useRef<any>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 1. Setup HTML Audio elements and events
  useEffect(() => {
    htmlAudioRef.current = new Audio();
    const audio = htmlAudioRef.current;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => {
      setDuration(audio.duration || 0);
    };
    const onEnded = () => {
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

  // Media Session API for Lock-Screen Controls
  useEffect(() => {
    if ("mediaSession" in navigator && currentSong) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist,
        album: currentSong.metadata?.album || "Strumm",
        artwork: [
          { src: currentSong.thumbnail || "", sizes: "96x96", type: "image/jpeg" },
          { src: currentSong.thumbnail || "", sizes: "256x256", type: "image/jpeg" },
          { src: currentSong.thumbnail || "", sizes: "512x512", type: "image/jpeg" },
        ],
      });

      navigator.mediaSession.setActionHandler("play", () => {
        usePlayerStore.getState().togglePlay();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        usePlayerStore.getState().togglePlay();
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        usePlayerStore.getState().prev();
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        usePlayerStore.getState().next();
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime && playerInstanceRef.current) {
          usePlayerStore.getState().setCurrentTime(details.seekTime);
          usePlayerStore.getState().playerRef?.seekTo(details.seekTime);
        }
      });
    }
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
  }, [currentSong, isPlaying]);

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

      const selectedAudioUrl =
        currentSong.metadata.audioVariants?.[audioQuality] ||
        currentSong.metadata.audioVariants?.high ||
        currentSong.metadata.audioUrl;
      const audioUrl = currentSong.videoId.startsWith("podcast-")
        ? apiUrl(`/podcast-audio?url=${encodeURIComponent(selectedAudioUrl || "")}&quality=${encodeURIComponent(audioQuality)}`)
        : selectedAudioUrl || "";
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
      // Pause HTML Audio player
      try {
        htmlAudioRef.current.pause();
      } catch (e) {}

      if (playerInstanceRef.current && currentSong?.videoId) {
        const activeVideoId = currentSong.videoId;
        if (currentVideoIdRef.current !== activeVideoId) {
          console.log("AudioEngine: Video ID changed from", currentVideoIdRef.current, "to", activeVideoId);
          currentVideoIdRef.current = activeVideoId;
          if (typeof playerInstanceRef.current.loadVideoById === "function") {
            try {
              playerInstanceRef.current.loadVideoById({
                videoId: activeVideoId,
                startSeconds: 0,
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
                if (isPlaying) {
                  ytPlayer.loadVideoById({
                    videoId: currentSong.videoId,
                    startSeconds: 0,
                  });
                } else {
                  ytPlayer.cueVideoById({
                    videoId: currentSong.videoId,
                    startSeconds: 0,
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
