"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";

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
  }, [handleTrackEnded]);

  // 2. Load YouTube API
  useEffect(() => {
    // Manually create the player target element outside of React Virtual DOM
    // to prevent React unmount "removeChild" mismatch errors.
    const playerDiv = document.createElement("div");
    playerDiv.id = "strumm-player-iframe";
    containerRef.current?.appendChild(playerDiv);

    if (!window.YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);

      window.onYouTubeIframeAPIReady = () => {
        initPlayer();
      };
    } else {
      initPlayer();
    }

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

  // 3. Watch for changes in active song
  useEffect(() => {
    if (!htmlAudioRef.current) return;

    if (currentSong?.metadata?.audioUrl) {
      // A. Podcast / HTML audio file
      // Pause YouTube player
      if (playerInstanceRef.current && typeof playerInstanceRef.current.pauseVideo === "function") {
        try {
          playerInstanceRef.current.pauseVideo();
        } catch (e) {}
      }
      stopProgressTimer();

      const audioUrl = currentSong.metadata.audioUrl;
      if (htmlAudioRef.current.src !== audioUrl) {
        htmlAudioRef.current.src = audioUrl;
        htmlAudioRef.current.load();
      }
      htmlAudioRef.current.volume = volume;

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
        }
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
          currentVideoIdRef.current = activeVideoId;
          if (typeof playerInstanceRef.current.loadVideoById === "function") {
            playerInstanceRef.current.loadVideoById({
              videoId: activeVideoId,
              startSeconds: 0,
            });
            setPlaying(true);
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
        });
      }
    }
  }, [currentSong?.videoId, currentSong?.metadata?.audioUrl]);

  // 4. Watch for play/pause toggle from UI
  useEffect(() => {
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
  }, [isPlaying]);

  // 5. Watch for volume changes from UI
  useEffect(() => {
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
  }, [volume]);

  const initPlayer = () => {
    if (!window.YT || !window.YT.Player) return;

    playerInstanceRef.current = new window.YT.Player("strumm-player-iframe", {
      height: "0",
      width: "0",
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
          const ytPlayer = event.target;
          if (!currentSong?.metadata?.audioUrl) {
            setPlayerRef({
              playVideo: () => ytPlayer.playVideo(),
              pauseVideo: () => ytPlayer.pauseVideo(),
              seekTo: (sec: number) => ytPlayer.seekTo(sec, true),
              setVolume: (vol: number) => ytPlayer.setVolume(vol),
              setPlaybackRate: (rate: number) => ytPlayer.setPlaybackRate(rate),
            });
            ytPlayer.setVolume(Math.round(volume * 100));
            if (currentSong?.videoId) {
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
          if (currentSong?.metadata?.audioUrl) return; // skip if playing podcast

          const state = event.data;
          if (state === 1) {
            setPlaying(true);
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
        onError: () => {
          if (currentSong?.metadata?.audioUrl) return;
          console.error("Strumm Music Engine: Error streaming track, skipping...");
          stopProgressTimer();
          usePlayerStore.getState().next();
        },
      },
    });
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

  return <div ref={containerRef} className="absolute opacity-0 pointer-events-none w-1 h-1 -left-[9999px] -top-[9999px]" />;
}
