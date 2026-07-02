"use client";

import { useEffect, useRef, useCallback } from "react";
import type { VideoProviderProps, VideoProviderActions } from "web/services/player/VideoProvider";


declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: {
      Player: new (
        elementId: string,
        config: YTPlayerConfig,
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

interface YTPlayerConfig {
  height: string | number;
  width: string | number;
  videoId: string;
  playerVars?: Record<string, any>;
  events?: Record<string, (event: any) => void>;
}

/**
 * YouTubeVideoPlayer — wraps the YouTube IFrame Player API.
 *
 * Renders a hidden player that can be shown when the user explicitly
 * chooses to watch video (videoMode).  Uses the official YouTube IFrame
 * Player API — no scraping, no proxying, no yt-dlp.
 *
 * The player is positioned off-screen when not in use so it can continue
 * audio playback without visual distraction.
 */
export default function YouTubeVideoPlayer({
  videoId,
  startSeconds,
  isPlaying,
  volume,
  playbackRate,
  playbackQuality,
  onReady,
  onPlay,
  onPause,
  onEnded,
  onTimeUpdate,
  onDurationChange,
  onError,
  onBuffering,
  onActionsReady,
}: VideoProviderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerInstanceRef = useRef<any>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const apiReadyRef = useRef(false);
  const playerReadyRef = useRef(false);
  const isDestroyedRef = useRef(false);

  // ---- Load YouTube IFrame API ----
  useEffect(() => {
    if (apiReadyRef.current) return;

    const loadAPI = () => {
      if (typeof window !== "undefined" && window.YT?.Player) {
        apiReadyRef.current = true;
        return;
      }

      window.onYouTubeIframeAPIReady = () => {
        apiReadyRef.current = true;
      };

      if (
        !document.querySelector(
          'script[src="https://www.youtube.com/iframe_api"]',
        )
      ) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
      }
    };

    loadAPI();
  }, []);

  // ---- Create / recreate player when videoId changes ----
  useEffect(() => {
    if (!apiReadyRef.current || !containerRef.current) return;
    isDestroyedRef.current = false;

    const checkReadyAndCreate = () => {
      if (!window.YT?.Player) {
        setTimeout(checkReadyAndCreate, 200);
        return;
      }

      if (playerInstanceRef.current) {
        try {
          playerInstanceRef.current.destroy();
        } catch {
          // ignore destroy errors
        }
        playerInstanceRef.current = null;
        playerReadyRef.current = false;
      }

      // Ensure container has an id'd child for the player
      let playerEl = document.getElementById("yt-video-player-embed");
      if (!playerEl) {
        playerEl = document.createElement("div");
        playerEl.id = "yt-video-player-embed";
        containerRef.current!.innerHTML = "";
        containerRef.current!.appendChild(playerEl);
      }

      try {
        const player = new window.YT.Player("yt-video-player-embed", {
          height: "100%",
          width: "100%",
          videoId,
          playerVars: {
            autoplay: isPlaying ? 1 : 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            fs: 1,
            iv_load_policy: 3,
            start: startSeconds || 0,
          },
          events: {
            onReady: () => {
              if (isDestroyedRef.current) return;
              playerReadyRef.current = true;

              const yt = playerInstanceRef.current;

              // Expose actions up
              const actions: VideoProviderActions = {
                playVideo: () => yt?.playVideo?.(),
                pauseVideo: () => yt?.pauseVideo?.(),
                seekTo: (sec: number) => yt?.seekTo?.(sec, true),
                setVolume: (vol: number) => yt?.setVolume?.(Math.round(vol)),
                setPlaybackRate: (rate: number) =>
                  yt?.setPlaybackRate?.(rate),
                setPlaybackQuality: (quality: string) => {
                  if (typeof yt?.setPlaybackQuality === "function") {
                    yt.setPlaybackQuality(quality);
                  }
                },
                destroy: () => {
                  try {
                    yt?.destroy();
                  } catch {
                    // ignore
                  }
                  playerReadyRef.current = false;
                  playerInstanceRef.current = null;
                },
              };

              onActionsReady(actions);
              onReady();

              // Apply initial settings
              yt?.setVolume?.(Math.round(volume * 100));
              yt?.setPlaybackRate?.(playbackRate);
              if (playbackQuality && typeof yt?.setPlaybackQuality === "function") {
                yt.setPlaybackQuality(playbackQuality);
              }
            },
            onStateChange: (event: any) => {
              if (isDestroyedRef.current) return;
              const state = event.data;
              const YT = window.YT!;
              if (state === YT.PlayerState.PLAYING) {
                onPlay();
                startProgressTimer();
              } else if (state === YT.PlayerState.PAUSED) {
                onPause();
                stopProgressTimer();
              } else if (state === YT.PlayerState.ENDED) {
                stopProgressTimer();
                onEnded();
              } else if (state === YT.PlayerState.BUFFERING) {
                onBuffering(true);
              } else if (state === YT.PlayerState.UNSTARTED) {
                // sync duration once when cued
                try {
                  const dur = playerInstanceRef.current?.getDuration?.();
                  if (dur && isFinite(dur)) {
                    onDurationChange(dur);
                  }
                } catch {
                  // ignore
                }
              }
            },
            onError: (err: any) => {
              if (isDestroyedRef.current) return;
              const errorCodes: Record<number, string> = {
                2: "Invalid video ID or parameter.",
                5: "Video player error — the HTML5 player could not render.",
                100: "Video not found (removed or private).",
                101: "Video embed not allowed.",
                150: "Video embed not allowed.",
              };
              const msg =
                errorCodes[err?.data] ||
                `YouTube playback error (${err?.data || "unknown"}).`;
              onError(msg);
            },
          },
        });

        playerInstanceRef.current = player;
      } catch (e: any) {
        onError(`Failed to create YouTube player: ${e?.message || "unknown"}`);
      }
    };

    checkReadyAndCreate();

    return () => {
      isDestroyedRef.current = true;
      stopProgressTimer();
      if (playerInstanceRef.current) {
        try {
          playerInstanceRef.current.destroy();
        } catch {
          // ignore
        }
        playerInstanceRef.current = null;
        playerReadyRef.current = false;
      }
    };
  }, [videoId, startSeconds]); // recreate when video changes

  // ---- Sync isPlaying ----
  useEffect(() => {
    const yt = playerInstanceRef.current;
    if (!yt || !playerReadyRef.current) return;

    try {
      const currentState = yt.getPlayerState?.();
      const YT = window.YT!;
      if (isPlaying && currentState !== YT.PlayerState.PLAYING) {
        yt.playVideo();
      } else if (!isPlaying && currentState === YT.PlayerState.PLAYING) {
        yt.pauseVideo();
      }
    } catch {
      // ignore
    }
  }, [isPlaying]);

  // ---- Sync volume ----
  useEffect(() => {
    const yt = playerInstanceRef.current;
    if (!yt || !playerReadyRef.current) return;
    try {
      yt.setVolume(Math.round(volume * 100));
    } catch {
      // ignore
    }
  }, [volume]);

  // ---- Sync playback rate ----
  useEffect(() => {
    const yt = playerInstanceRef.current;
    if (!yt || !playerReadyRef.current) return;
    try {
      yt.setPlaybackRate(playbackRate);
    } catch {
      // ignore
    }
  }, [playbackRate]);

  // ---- Sync playback quality ----
  useEffect(() => {
    const yt = playerInstanceRef.current;
    if (!yt || !playerReadyRef.current || !playbackQuality) return;
    try {
      if (typeof yt.setPlaybackQuality === "function") {
        yt.setPlaybackQuality(playbackQuality);
      }
    } catch {
      // ignore
    }
  }, [playbackQuality]);

  // ---- Progress timer ----
  const startProgressTimer = useCallback(() => {
    stopProgressTimer();
    progressTimerRef.current = setInterval(() => {
      const yt = playerInstanceRef.current;
      if (!yt || isDestroyedRef.current) return;
      try {
        const curr = yt.getCurrentTime?.();
        const dur = yt.getDuration?.();
        if (curr !== undefined && isFinite(curr)) {
          onTimeUpdate(curr);
        }
        if (dur !== undefined && isFinite(dur) && dur > 0) {
          onDurationChange(dur);
        }
      } catch {
        // ignore
      }
    }, 250);
  }, [onTimeUpdate, onDurationChange]);

  const stopProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopProgressTimer();
    };
  }, [stopProgressTimer]);

  return (
    <div
      ref={containerRef}
      className="w-full aspect-video rounded-2xl overflow-hidden border border-border/40 bg-black shadow-2xl"
    >
      {/* YouTube IFrame is injected into #yt-video-player-embed inside this div */}
    </div>
  );
}
