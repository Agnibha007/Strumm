"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Loader2, AlertTriangle, Play, Volume2, Maximize, RotateCw } from "lucide-react";

interface VideoPlayerProps {
  onVideoError?: () => void;
}

export default function VideoPlayer({ onVideoError }: VideoPlayerProps) {
  const {
    currentSong,
    isPlaying,
    volume,
    playbackRate,
    currentTime,
    setCurrentTime,
    setDuration,
    setPlaying,
    setPlayerRef,
    handleTrackEnded,
    setPodcastMode,
    audioQuality,
  } = usePlayerStore();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const videoUrl = currentSong?.metadata?.videoUrl;

  // Initialize and synchronize playback states when song/url changes
  useEffect(() => {
    if (!videoRef.current || !videoUrl) return;

    setError(null);
    setLoading(true);

    const video = videoRef.current;
    
    // Sync current time from store when video changes or mounts
    const syncTime = usePlayerStore.getState().currentTime;
    if (syncTime > 0 && isFinite(syncTime)) {
      video.currentTime = syncTime;
    }

    video.volume = volume;
    video.playbackRate = playbackRate;
    video.preload = audioQuality === "data-saver" ? "metadata" : "auto";

    if (isPlaying) {
      video.play().catch((err) => {
        console.warn("Video auto-play blocked or failed:", err);
      });
    } else {
      video.pause();
    }
  }, [videoUrl, audioQuality, isPlaying, playbackRate, volume]);

  // Sync isPlaying with HTML5 video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video || loading || error) return;

    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isPlaying, loading, error]);

  // Sync volume with HTML5 video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  // Sync playbackRate with HTML5 video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Register store controller callbacks for play/pause/seek
  useEffect(() => {
    setPlayerRef({
      playVideo: () => {
        videoRef.current?.play().catch(() => {});
      },
      pauseVideo: () => {
        videoRef.current?.pause();
      },
      seekTo: (sec: number) => {
        if (videoRef.current && isFinite(sec)) {
          videoRef.current.currentTime = sec;
        }
      },
      setVolume: (vol: number) => {
        if (videoRef.current) {
          videoRef.current.volume = vol / 100;
        }
      },
      setPlaybackRate: (rate: number) => {
        if (videoRef.current) {
          videoRef.current.playbackRate = rate;
        }
      },
    });

    return () => {
      // Clear playerRef when video unmounts
      setPlayerRef(null);
    };
  }, [setPlayerRef]);

  // Event handlers
  const handlePlay = () => setPlaying(true);
  const handlePause = () => setPlaying(false);
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };
  const handleDurationChange = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration || 0);
    }
  };
  const handleEnded = () => {
    handleTrackEnded();
  };
  const handleCanPlay = () => {
    setLoading(false);
    // Auto play if store says playing
    if (isPlaying) {
      videoRef.current?.play().catch(() => {});
    }
  };
  const handleWaiting = () => {
    setLoading(true);
  };
  const handleError = () => {
    setError("Video unavailable");
    setLoading(false);
    if (onVideoError) {
      onVideoError();
    }
  };

  const handleFallbackToAudio = () => {
    setPodcastMode("audio");
  };

  if (error) {
    return (
      <div className="w-full aspect-video rounded-2xl bg-surface-elevated border border-border/40 flex flex-col items-center justify-center p-6 text-center space-y-4 shadow-2xl">
        <AlertTriangle className="w-12 h-12 text-red-400 animate-pulse" />
        <div className="space-y-1">
          <h3 className="text-lg font-editorial font-bold text-text">{error}</h3>
          <p className="text-xs text-muted max-w-xs">We encountered an issue loading this video stream.</p>
        </div>
        <button
          onClick={handleFallbackToAudio}
          className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer transition select-none shadow-md"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          Continue with audio
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden border border-border/40 bg-black shadow-2xl group">
      {/* HTML5 Video element */}
      <video
        ref={videoRef}
        src={videoUrl || undefined}
        className="w-full h-full object-contain"
        preload={audioQuality === "data-saver" ? "metadata" : "auto"}
        playsInline
        controls
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
        onEnded={handleEnded}
        onCanPlay={handleCanPlay}
        onWaiting={handleWaiting}
        onError={handleError}
      />

      {/* Loading Spinner overlay */}
      {loading && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center transition-opacity pointer-events-none">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      )}
    </div>
  );
}
