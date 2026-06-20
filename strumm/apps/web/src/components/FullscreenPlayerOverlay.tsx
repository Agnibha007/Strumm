"use client";

import { useEffect, useState, useRef } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useThemeStore } from "web/store/useThemeStore";
import { useAuthStore } from "web/store/useAuthStore";
import {
  Play, 
  Pause, 
  SkipForward, 
  SkipBack, 
  Shuffle, 
  Repeat, 
  Volume2, 
  Minimize2, 
  Mic2, 
  Loader2,
  Share2,
  Check,
  Download,
  Heart,
  ListMusic,
  Trash2,
  ChevronUp,
  ChevronDown,
  X
} from "lucide-react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import { apiUrl, cleanText } from "web/lib/api";
import { getActiveLyricIndex, parseLrc, type LyricLine } from "web/lib/lyrics";
import SongArtwork from "web/components/SongArtwork";
import { useRouter } from "next/navigation";
import AddToPlaylistMenu from "web/components/AddToPlaylistMenu";

interface FullscreenPlayerOverlayProps {
  onClose: () => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export default function FullscreenPlayerOverlay({ onClose }: FullscreenPlayerOverlayProps) {
  const {
    currentSong,
    isPlaying,
    currentTime,
    duration,
    volume,
    repeatMode,
    isShuffle,
    playerRef,
    playbackRate,
    togglePlay,
    next,
    prev,
    setVolume,
    setCurrentTime,
    setShuffle,
    setRepeatMode,
    setPlaybackRate,
    queue,
    currentIndex,
  } = usePlayerStore();
  const { token } = useAuthStore();

  const { isAnimated } = useThemeStore();
  const router = useRouter();
  
  const [showQueue, setShowQueue] = useState(false);

  const removeSong = (idxToRemove: number) => {
    const newQueue = queue.filter((_, idx) => idx !== idxToRemove);
    let newIndex = currentIndex;
    if (idxToRemove === currentIndex) {
      if (newQueue.length > 0) {
        newIndex = idxToRemove >= newQueue.length ? newQueue.length - 1 : idxToRemove;
        usePlayerStore.getState().playSong(newQueue[newIndex], newQueue);
      } else {
        usePlayerStore.setState({ currentSong: null, currentIndex: -1, isPlaying: false, queue: [] });
      }
    } else {
      if (idxToRemove < currentIndex) {
        newIndex = currentIndex - 1;
      }
      usePlayerStore.setState({ queue: newQueue, currentIndex: newIndex });
    }
  };

  const moveSong = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= queue.length) return;
    const newQueue = [...queue];
    const [removed] = newQueue.splice(fromIdx, 1);
    newQueue.splice(toIdx, 0, removed);
    
    let newIndex = currentIndex;
    if (currentIndex === fromIdx) {
      newIndex = toIdx;
    } else if (currentIndex === toIdx) {
      newIndex = fromIdx;
    } else if (fromIdx < currentIndex && toIdx >= currentIndex) {
      newIndex = currentIndex - 1;
    } else if (fromIdx > currentIndex && toIdx <= currentIndex) {
      newIndex = currentIndex + 1;
    }
    usePlayerStore.setState({ queue: newQueue, currentIndex: newIndex });
  };
  
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsSource, setLyricsSource] = useState<string | null>(null);
  const [isLiked, setIsLiked] = useState(false);

  useEffect(() => {
    if (!currentSong?.videoId || !token) return;
    fetch(apiUrl(`/liked/${currentSong.videoId}`), {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(json => {
        if (json.success) setIsLiked(json.data.liked);
      })
      .catch(() => {});
  }, [currentSong?.videoId, token]);

  const handleLikeToggle = async () => {
    if (!currentSong || !token) return;
    try {
      const response = await fetch(apiUrl("/liked"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(currentSong)
      });
      const json = await response.json();
      if (json.success) {
        setIsLiked(json.data.liked);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem("strumm-show-lyrics");
      if (cached !== null) {
        setShowLyrics(cached === "true");
      }
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentSong?.videoId) return;

    const originalPath = window.location.pathname + window.location.search;
    const songId = currentSong.videoId;
    
    window.history.pushState({ isSongOverlay: true }, "", `/song/${songId}`);

    const handlePopState = () => {
      onClose();
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (window.location.pathname.startsWith("/song/")) {
        window.history.replaceState(null, "", originalPath);
      }
    };
  }, [currentSong?.videoId, onClose]);
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleShare = async () => {
    if (typeof window === "undefined" || !currentSong) return;
    const shareUrl = `${window.location.origin}/song/${currentSong.videoId}`;
    const shareData = {
      title: currentSong.title,
      text: `Listen to "${currentSong.title}" by ${currentSong.artist} on Strumm`,
      url: shareUrl,
    };

    if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
      try {
        await navigator.share(shareData);
        return;
      } catch (e) {
        console.warn("Share aborted or failed:", e);
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy link:", err);
    }
  };

  const safeFileName = (value: string) => {
    return cleanText(value, 120).replace(/[\\/:*?"<>|]+/g, "-") || "strumm-track";
  };

  const handleDownload = async () => {
    if (!currentSong || typeof window === "undefined" || downloadState === "loading") return;

    const directAudioUrl = currentSong.metadata?.audioUrl;
    setDownloadError(null);
    setDownloadState("loading");

    const filename = `${safeFileName(`${currentSong.title} - ${currentSong.artist}`)}.mp3`;
    const downloadUrl = directAudioUrl
      ? apiUrl(`/download-audio?url=${encodeURIComponent(directAudioUrl)}&filename=${encodeURIComponent(filename)}`)
      : apiUrl(`/download/${encodeURIComponent(currentSong.videoId)}?title=${encodeURIComponent(safeFileName(`${currentSong.title} - ${currentSong.artist}`))}`);

    try {
      let res;
      let succeeded = false;
      try {
        res = await fetch(downloadUrl);
        if (!res.ok) {
          throw new Error("Backend failed");
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.rel = "noopener noreferrer";
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
        succeeded = true;
      } catch (backendErr) {
        // Fallback directly to Cobalt API from frontend if youtube track
        if (!directAudioUrl && currentSong.videoId) {
          const cobaltResp = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: `https://www.youtube.com/watch?v=${currentSong.videoId}`,
              downloadMode: "audio",
              audioFormat: "mp3"
            })
          });
          if (cobaltResp.ok) {
            const cobaltData = await cobaltResp.json();
            if (cobaltData.url) {
              const link = document.createElement("a");
              link.href = cobaltData.url;
              link.download = filename;
              document.body.appendChild(link);
              link.click();
              link.remove();
              succeeded = true;
            }
          }
        }
        
        if (!succeeded) {
          throw new Error("Download failed. Track might be unavailable.");
        }
      }
      
      setDownloadState("success");
      setTimeout(() => setDownloadState("idle"), 2000);
    } catch (err: any) {
      setDownloadError(err.message || "Failed to download track");
      setDownloadState("error");
      setTimeout(() => {
        setDownloadState("idle");
        setDownloadError(null);
      }, 4000);
    }
  };

  const activeLineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 1. Format seconds to MM:SS
  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds === null || seconds === undefined) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 2. Fetch Lyrics on song load
  useEffect(() => {
    if (!currentSong?.videoId || currentSong.videoId.startsWith("podcast-")) {
      setLyricsLoading(false);
      setLyrics(null);
      setPlainLyrics(null);
      return;
    }

    const fetchLyrics = async () => {
      setLyricsLoading(true);
      setLyrics(null);
      setPlainLyrics(null);
      setLyricsSource(null);
      try {
        const response = await fetch(
          apiUrl(`/lyrics/${encodeURIComponent(currentSong.videoId)}?title=${encodeURIComponent(cleanText(currentSong.title, 160))}&artist=${encodeURIComponent(cleanText(currentSong.artist, 160))}`)
        );
        const json = await response.json();
        
        if (json.success && json.data) {
          const synced = json.data.synced;
          const plain = json.data.plain;
          const parsedLyrics = synced ? parseLrc(synced) : [];
          setLyricsSource(json.data.source);
          
          if (json.data.isSynced && parsedLyrics.length > 0) {
            setLyrics(parsedLyrics);
          } else {
            setPlainLyrics(plain || "Lyrics are synced to sound, but timestamps are missing.");
          }
        } else {
          setPlainLyrics("Lyrics not found. Curation engine is ready.");
        }
      } catch (e) {
        setPlainLyrics("Offline fallback. Lyrics curating soon.");
      } finally {
        setLyricsLoading(false);
      }
    };

    fetchLyrics();
  }, [currentSong?.videoId]);

  // 3. Calculate active lyric index from LRCLIB timestamps
  const activeIndex = getActiveLyricIndex(lyrics, currentTime);

  // 4. Scroll active lyric line to center
  useEffect(() => {
    if (activeLineRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const element = activeLineRef.current;
      
      const containerHeight = container.clientHeight;
      const elementTop = element.offsetTop;
      const elementHeight = element.clientHeight;
      
      container.scrollTo({
        top: elementTop - containerHeight / 2 + elementHeight / 2,
        behavior: "smooth",
      });
    }
  }, [activeIndex, lyricsLoading]);

  if (!currentSong) return null;

  const isPodcast = currentSong.videoId.startsWith("podcast-");
  const effectiveShowLyrics = showLyrics && !isPodcast;

  return (
    <div className={`fixed inset-0 z-50 bg-background/95 backdrop-blur-3xl flex flex-col p-4 md:p-12 text-text overflow-x-hidden select-none transition-all ${effectiveShowLyrics ? "overflow-y-hidden" : "overflow-y-auto"}`}>
      {/* Dynamic ambient background glowing blobs */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-72 h-72 md:w-96 md:h-96 rounded-full bg-primary/10 blur-[100px] pointer-events-none animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-72 h-72 md:w-96 md:h-96 rounded-full bg-accent/5 blur-[120px] pointer-events-none animate-pulse" />

      {/* Header bar */}
      <div className="flex justify-between items-center z-10 flex-shrink-0 border-b border-border/20 pb-4">
        <button 
          onClick={onClose} 
          className="flex items-center gap-2 text-muted hover:text-text cursor-pointer group transition"
        >
          <Minimize2 className="w-5 h-5 group-hover:scale-110 transition-transform" />
          <span className="text-xs uppercase tracking-wider font-semibold">Minimize</span>
        </button>

        <div className="text-center hidden md:block">
          <span className="text-[9px] tracking-widest uppercase font-semibold text-muted">Now Playing</span>
          <h3 className="text-xs font-semibold tracking-wide text-text/80 truncate max-w-[200px] md:max-w-[450px] mt-0.5">
            {currentSong.metadata?.album || "Strumm Ecosystem"}
          </h3>
        </div>

        <div className="flex items-center gap-2">
          {!isPodcast && (
            <button
              onClick={() => {
                const nextVal = !showLyrics;
                setShowLyrics(nextVal);
                localStorage.setItem("strumm-show-lyrics", String(nextVal));
              }}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-bold cursor-pointer transition-all ${
                effectiveShowLyrics
                  ? "bg-primary border-primary text-text shadow-md box-glow"
                  : "bg-surface-elevated/40 border-border/30 text-muted hover:text-text hover:border-primary/50"
              }`}
              title={effectiveShowLyrics ? "Hide Lyrics" : "Show Lyrics"}
            >
              <Mic2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{effectiveShowLyrics ? "Hide Lyrics" : "Show Lyrics"}</span>
            </button>
          )}
          
          <button
            onClick={handleLikeToggle}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-bold cursor-pointer transition-all ${
              isLiked
                ? "bg-primary/20 border-primary text-primary shadow-md box-glow"
                : "border-border/30 bg-surface-elevated/40 text-muted hover:text-primary hover:border-primary/50"
            }`}
            title={isLiked ? "Unlike" : "Like"}
          >
            <Heart className={`w-3.5 h-3.5 ${isLiked ? "fill-current" : ""}`} />
            <span className="hidden sm:inline">{isLiked ? "Liked" : "Like"}</span>
          </button>
        </div>
      </div>

      {/* Main Grid/Flex View */}
      <div className={`w-full flex-1 mt-4 md:mt-10 min-h-0 z-10 mx-auto max-w-7xl transition-all duration-500 ${
        effectiveShowLyrics 
          ? "flex flex-col lg:grid lg:grid-cols-2 gap-4 lg:gap-16" 
          : "flex flex-col items-center justify-center max-w-xl"
      }`}>
        
        {/* Left Side: Song Details & Controls */}
        <div className={`flex flex-col justify-center items-center w-full transition-all duration-500 ${
          effectiveShowLyrics 
            ? "gap-2 lg:gap-6 lg:items-start text-center lg:text-left flex-shrink-0" 
            : "gap-6 h-full items-center text-center"
        }`}>
          
          {/* Album Cover Card */}
          <div className={`relative group flex-shrink-0 ${effectiveShowLyrics ? "hidden lg:block" : "block"}`}>
            <div
              className={`overflow-hidden border border-border/40 relative shadow-[0_25px_60px_rgba(0,0,0,0.65)] bg-surface-elevated flex-shrink-0 transition-all duration-500 rounded-2xl md:rounded-3xl ${
                effectiveShowLyrics 
                  ? "w-52 h-52 md:w-72 md:h-72" 
                  : "w-64 h-64 md:w-80 md:h-80"
              }`}
            >
              <SongArtwork song={currentSong} className="w-full h-full" iconClassName="w-14 h-14" />
              {/* Premium reflection gloss overlay */}
              <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-white/10 pointer-events-none" />
            </div>
          </div>

          {/* Song title and artist */}
          <div className="w-full min-w-0 overflow-hidden px-2">
            <h2 className={`font-editorial font-bold text-text leading-tight tracking-tight mb-1 w-full truncate transition-all ${effectiveShowLyrics ? "text-xl md:text-3xl lg:text-5xl" : "text-2xl md:text-4xl lg:text-5xl"}`}>
              {currentSong.title}
            </h2>
            <p className={`text-muted font-medium w-full truncate transition-all ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
              {currentSong.artist}
            </p>
          </div>

          {/* Playback speed selector */}
          <div className={`flex flex-col items-center gap-1.5 w-full transition-all ${
            effectiveShowLyrics ? "hidden lg:flex lg:items-start" : "flex items-center"
          }`}>
            <span className="text-[10px] tracking-wider uppercase font-semibold text-muted/60">Speed Control</span>
            <div className="flex items-center gap-1 bg-surface-elevated/40 border border-border/30 p-1 rounded-full w-fit backdrop-blur-md">
              {SPEED_OPTIONS.map((rate) => (
                <button
                  key={rate}
                  onClick={() => setPlaybackRate(rate)}
                  className={`px-3 py-1 rounded-full text-[11px] font-semibold cursor-pointer transition ${
                    playbackRate === rate
                      ? "bg-primary text-text shadow-md box-glow"
                      : "text-muted hover:text-text hover:bg-surface-elevated/60"
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>

          {/* Scrubber timeline */}
          <div className="w-full flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[10px] text-muted font-semibold tracking-wider">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            
            <div className="relative group flex items-center h-4 w-full">
              <input
                type="range"
                min="0"
                max={duration || 100}
                step="1"
                value={currentTime}
                onChange={(e) => {
                  const newTime = parseFloat(e.target.value);
                  playerRef?.seekTo(newTime);
                  setCurrentTime(newTime);
                }}
                className="w-full h-1 bg-border/40 group-hover:h-1.5 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none transition-all"
                style={{
                  background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${progressPercent}%, rgba(255,255,255,0.05) ${progressPercent}%, rgba(255,255,255,0.05) 100%)`
                }}
              />
            </div>
          </div>

          {/* Player controls */}
          <div className={`flex items-center justify-center gap-5 md:gap-7 w-full mt-1 transition-all ${
            effectiveShowLyrics ? "lg:justify-start" : "justify-center"
          }`}>
            <button
              onClick={() => setShuffle(!isShuffle)}
              className={`p-2 cursor-pointer transition hover:scale-105 ${isShuffle ? "text-primary text-glow" : "text-muted hover:text-text"}`}
              title="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>
            
            <button 
              onClick={prev} 
              className="p-2 text-muted hover:text-text cursor-pointer transition hover:scale-105"
              title="Previous"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            
            <button 
              onClick={togglePlay} 
              className="p-4 bg-text text-background rounded-full hover:scale-110 cursor-pointer transition shadow-xl flex items-center justify-center box-glow"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-current text-background" />
              ) : (
                <Play className="w-5 h-5 fill-current translate-x-0.5 text-background" />
              )}
            </button>
            
            <button 
              onClick={next} 
              className="p-2 text-muted hover:text-text cursor-pointer transition hover:scale-105"
              title="Next"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
            
            <button
              onClick={() => setRepeatMode(repeatMode === "none" ? "all" : repeatMode === "all" ? "one" : "none")}
              className={`p-2 cursor-pointer relative transition hover:scale-105 ${repeatMode !== "none" ? "text-primary text-glow" : "text-muted hover:text-text"}`}
              title="Repeat Mode"
            >
              <Repeat className="w-4 h-4" />
              {repeatMode === "one" && (
                <span className="absolute text-[7px] font-extrabold text-primary translate-x-1.5 -translate-y-2">1</span>
              )}
            </button>
          </div>

          {/* Secondary Action controls */}
          <div className={`flex items-center justify-center gap-6 w-full mt-2 transition-all ${
            effectiveShowLyrics ? "hidden lg:flex lg:justify-start" : "flex justify-center"
          }`}>

            <button
              onClick={handleShare}
              className={`p-2 cursor-pointer transition hover:scale-105 ${copied ? "text-primary text-glow animate-pulse" : "text-muted hover:text-text"}`}
              title={copied ? "Link Copied!" : "Share track"}
            >
              {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
            </button>

            <AddToPlaylistMenu song={currentSong} className="!p-0 !bg-transparent hover:!bg-transparent hover:scale-105" />

            <button
              onClick={handleDownload}
              disabled={downloadState === "loading"}
              className={`p-2 cursor-pointer transition hover:scale-105 ${
                downloadState === "success"
                  ? "text-primary text-glow animate-pulse"
                  : downloadState === "error"
                  ? "text-red-400 animate-pulse"
                  : downloadState === "loading"
                  ? "text-muted opacity-50 cursor-not-allowed animate-pulse"
                  : "text-muted hover:text-text"
              }`}
              title="Download MP3"
            >
              {downloadState === "success" ? <Check className="w-4 h-4" /> : downloadState === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setShowQueue(true)}
              className="p-2 text-muted hover:text-text cursor-pointer transition hover:scale-105"
              title="Show Play Queue"
            >
              <ListMusic className="w-4 h-4" />
            </button>
          </div>

          {downloadError && (
            <p className="text-[10px] text-red-300/80 font-semibold tracking-wide text-center lg:text-left">
              {downloadError}
            </p>
          )}

          {/* Volume control */}
          <div className={`flex items-center gap-3 w-full max-w-[200px] mt-1 justify-center transition-all ${
            effectiveShowLyrics ? "hidden lg:flex lg:justify-start" : "flex justify-center"
          }`}>
            <Volume2 className="w-4 h-4 text-muted" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-full h-1 bg-border/40 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none"
              style={{
                background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${volume * 100}%, rgba(255,255,255,0.05) ${volume * 100}%, rgba(255,255,255,0.05) 100%)`
              }}
            />
          </div>

        </div>

        {/* Right Side: Lyrics Section */}
        {effectiveShowLyrics && (
          <div className="flex flex-col flex-1 lg:h-full bg-surface-elevated/20 border border-border/30 rounded-3xl p-4 md:p-7 min-h-0 overflow-hidden backdrop-blur-md w-full transition-all">
            <div className="flex justify-between items-center border-b border-border/20 pb-3 mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Mic2 className="w-4 h-4 text-primary" />
                <span className="text-xs tracking-wider uppercase font-semibold text-muted">Lyrics Curation</span>
              </div>
              {lyrics && (
                <span className="text-[10px] text-muted/60 tracking-wide font-medium">Click line to jump</span>
              )}
            </div>

            {/* Scrolling Container */}
            <div 
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto pr-1 scrollbar-none my-2 space-y-5 text-center min-h-0"
            >
              {lyricsLoading ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-muted py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  <span className="text-xs">Extracting syllables...</span>
                </div>
              ) : lyrics ? (
                lyrics.map((line, idx) => {
                  const isActive = idx === activeIndex;
                  return (
                    <div
                      key={idx}
                      ref={isActive ? activeLineRef : null}
                      onClick={() => {
                        playerRef?.seekTo(line.time);
                        setCurrentTime(line.time);
                      }}
                      className={`transition-all duration-300 py-1.5 cursor-pointer leading-relaxed text-lg md:text-xl lg:text-2xl font-editorial font-bold ${
                        isActive 
                          ? "text-primary text-glow scale-105 py-2.5" 
                          : "text-muted/30 hover:text-muted/70 hover:scale-[1.01]"
                      }`}
                    >
                      {line.text}
                    </div>
                  );
                })
              ) : (
                <div className="whitespace-pre-line py-8 text-muted/80 leading-relaxed font-editorial text-center italic text-base md:text-lg">
                  {plainLyrics}
                </div>
              )}
            </div>

            {lyricsSource !== "ytmusic" && (
              <div className="mt-2 text-center text-[9px] text-muted/40 tracking-wider uppercase flex-shrink-0">
                Synced with Strumm Curation Engine
              </div>
            )}
          </div>
        )}

      </div>

      {/* Queue Modal overlay */}
      <AnimatePresence>
        {showQueue && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowQueue(false)}
              className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-md bg-surface border border-border/60 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] z-10 p-5 md:p-6"
            >
              <div className="border-b border-border/20 pb-3 mb-3 flex justify-between items-center">
                <h3 className="font-editorial text-text font-bold text-lg">Play Queue ({queue.length})</h3>
                <button 
                  onClick={() => setShowQueue(false)} 
                  className="p-1.5 rounded-lg hover:bg-white/10 text-muted hover:text-text cursor-pointer transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                {queue.length === 0 ? (
                  <p className="text-sm text-muted text-center py-8">Queue is empty</p>
                ) : (
                  <Reorder.Group
                    axis="y"
                    values={queue}
                    onReorder={(newQueue) => {
                      if (currentSong) {
                        const newIndex = newQueue.findIndex((s) => s.videoId === currentSong.videoId);
                        usePlayerStore.setState({ queue: newQueue, currentIndex: newIndex });
                      } else {
                        usePlayerStore.setState({ queue: newQueue });
                      }
                    }}
                    className="flex flex-col gap-2 overflow-y-auto max-h-[60vh] pr-1"
                  >
                    {queue.map((s, idx) => (
                      <Reorder.Item
                        key={s.videoId}
                        value={s}
                        className={`flex items-center justify-between p-2 rounded-xl transition w-full ${
                          currentSong?.videoId === s.videoId ? "bg-primary/10 text-primary font-semibold" : "hover:bg-white/5"
                        } cursor-grab active:cursor-grabbing select-none`}
                      >
                        <button
                          onClick={() => {
                            usePlayerStore.getState().playSong(s, queue);
                          }}
                          className="flex items-center gap-3 text-left cursor-pointer flex-grow min-w-0 pointer-events-auto"
                        >
                          <SongArtwork song={s} className="w-8 h-8 rounded flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-text truncate leading-tight">{s.title}</div>
                            <div className="text-[10px] text-muted truncate">{s.artist}</div>
                          </div>
                        </button>
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2 pointer-events-auto">
                          <button
                            disabled={idx === 0}
                            onClick={(e) => { e.stopPropagation(); moveSong(idx, idx - 1); }}
                            className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition text-muted hover:text-text"
                            title="Move Up"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            disabled={idx === queue.length - 1}
                            onClick={(e) => { e.stopPropagation(); moveSong(idx, idx + 1); }}
                            className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition text-muted hover:text-text"
                            title="Move Down"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeSong(idx); }}
                            className="p-1 rounded hover:bg-red-500/10 cursor-pointer transition text-muted hover:text-red-400"
                            title="Remove"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
