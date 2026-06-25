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
  X,
  Video,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import { apiUrl, cleanText, decodeHtml } from "web/lib/api";
import { formatTime } from "web/lib/format";
import { useLikeSong } from "web/hooks/useLikeSong";
import { getActiveLyricIndex, parseLrc, type LyricLine } from "web/lib/lyrics";
import SongArtwork from "web/components/SongArtwork";
import { useRouter } from "next/navigation";
import AddToPlaylistMenu from "web/components/AddToPlaylistMenu";
import VideoPlayer from "web/components/VideoPlayer";

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
    podcastMode,
    setPodcastMode,
    playerError,
    isPlayerLoading,
  } = usePlayerStore();
  const { token } = useAuthStore();
  const { isLiked, toggleLike } = useLikeSong(currentSong?.videoId, token);

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
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const [memoryNote, setMemoryNote] = useState("");
  const [memoryVisibility, setMemoryVisibility] = useState<"public" | "private">("private");
  const [memorySaving, setMemorySaving] = useState(false);
  const [memorySuccess, setMemorySuccess] = useState(false);

  const handleSaveMemory = async () => {
    if (!currentSong || !token) return;
    setMemorySaving(true);
    try {
      const response = await fetch(apiUrl("/memories"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          song: currentSong,
          note: memoryNote,
          visibility: memoryVisibility
        })
      });
      const json = await response.json();
      if (json.success) {
        setMemorySuccess(true);
        setMemoryNote("");
        setTimeout(() => {
          setMemorySuccess(false);
          setShowMemoryModal(false);
        }, 1500);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setMemorySaving(false);
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
    const isPodcast = songId.startsWith("podcast-");
    
    const targetPath = isPodcast 
      ? `/podcast/${songId.substring("podcast-".length)}` 
      : `/song/${songId}`;

    window.history.pushState({ isSongOverlay: true }, "", targetPath);

    const handlePopState = () => {
      onClose();
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (window.location.pathname.startsWith("/song/") || window.location.pathname.startsWith("/podcast/")) {
        window.history.replaceState(null, "", originalPath);
      }
    };
  }, [currentSong?.videoId, onClose]);
  const [copied, setCopied] = useState(false);
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleShare = async () => {
    if (typeof window === "undefined" || !currentSong) return;
    
    const isPodcast = currentSong.videoId.startsWith("podcast-");
    const sharePath = isPodcast 
      ? `/podcast/${currentSong.videoId.substring("podcast-".length)}` 
      : `/song/${currentSong.videoId}`;
      
    const shareUrl = `${window.location.origin}${sharePath}`;
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
        throw new Error("Download failed. Track might be unavailable.");
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

  const isFirstScrollRef = useRef(true);

  useEffect(() => {
    isFirstScrollRef.current = true;
  }, [currentSong?.videoId, showLyrics]);

  // 4. Scroll active lyric line to center
  useEffect(() => {
    if (activeLineRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const element = activeLineRef.current;
      
      const containerHeight = container.clientHeight;
      const elementTop = element.offsetTop;
      const elementHeight = element.clientHeight;
      
      const isFirst = isFirstScrollRef.current;
      if (isFirst) {
        isFirstScrollRef.current = false;
      }
      
      container.scrollTo({
        top: elementTop - containerHeight / 2 + elementHeight / 2,
        behavior: isFirst ? "auto" : "smooth",
      });
    }
  }, [activeIndex, lyricsLoading, showLyrics]);

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
          {isPodcast && currentSong?.metadata?.videoAvailable && (
            <button
              onClick={() => setPodcastMode(podcastMode === "video" ? "audio" : "video")}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary text-primary hover:bg-primary/10 text-xs font-bold cursor-pointer transition-all shadow-md box-glow"
              title={podcastMode === "video" ? "Switch to Audio Mode" : "Switch to Video Mode"}
            >
              <Video className="w-3.5 h-3.5 fill-current" />
              <span>{podcastMode === "video" ? "Listen Audio" : "Watch Video"}</span>
            </button>
          )}

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
            onClick={() => currentSong && toggleLike(currentSong).catch(console.error)}
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

          {!isPodcast && (
            <button
              onClick={() => setShowMemoryModal(true)}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-border/30 bg-surface-elevated/40 text-muted hover:text-accent hover:border-accent/50 text-xs font-bold cursor-pointer transition-all"
              title="Attach Memory"
            >
              <Sparkles className="w-3.5 h-3.5 text-accent animate-pulse" />
              <span className="hidden sm:inline">Memory</span>
            </button>
          )}
        </div>
      </div>

      {/* Video Mode View or Audio/Lyrics Mode View */}
      {podcastMode === "video" && currentSong.metadata?.videoAvailable ? (
        <div className="w-full flex-1 mt-4 md:mt-8 min-h-0 z-10 mx-auto max-w-7xl flex flex-col lg:grid lg:grid-cols-3 gap-6 lg:gap-8 overflow-y-auto lg:overflow-hidden p-1">
          {/* Left/Main Column: Video Player, Episode Info */}
          <div className="lg:col-span-2 flex flex-col gap-4 lg:h-full lg:overflow-y-auto pr-1">
            {/* Header info / Episode artwork */}
            <div className="flex items-center gap-4 border-b border-border/20 pb-4">
              <div className="w-16 h-16 rounded-lg overflow-hidden border border-border/40 flex-shrink-0 bg-surface-elevated">
                <SongArtwork song={currentSong} className="w-full h-full" iconClassName="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <span className="text-[10px] tracking-wider uppercase font-semibold text-primary block">
                  {currentSong.metadata?.album || "Podcast Show"}
                </span>
                <h2 className="text-xl md:text-2xl font-editorial font-bold text-text truncate">
                  {currentSong.title}
                </h2>
                {playerError ? (
                  <p className="text-xs text-red-500 font-semibold animate-pulse truncate">
                    {playerError}
                  </p>
                ) : isPlayerLoading ? (
                  <p className="text-xs text-primary truncate flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                  </p>
                ) : (
                  <p className="text-xs text-muted truncate">
                    {currentSong.artist}
                  </p>
                )}
              </div>
            </div>

            {/* Video Player Component */}
            <div className="w-full">
              <VideoPlayer />
            </div>

            {/* Episode details / Description */}
            <div className="bg-surface-elevated/20 border border-border/30 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold tracking-wide uppercase text-muted">Episode Description</h3>
              <div 
                className="text-sm text-text/80 leading-relaxed max-h-48 overflow-y-auto scrollbar-thin podcast-description break-words"
                dangerouslySetInnerHTML={{ 
                  __html: currentSong.metadata?.description 
                    ? decodeHtml(currentSong.metadata.description) 
                    : "No description available." 
                }}
              />
            </div>
            
            {/* Scrubber timeline & Main Controls for video */}
            <div className="bg-surface-elevated/20 border border-border/30 rounded-2xl p-5 space-y-4">
              {/* Timeline scrubber */}
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

              {/* Control buttons */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={prev} 
                    className="p-2 text-muted hover:text-text cursor-pointer transition hover:scale-105"
                    title="Previous"
                  >
                    <SkipBack className="w-5 h-5 fill-current" />
                  </button>
                  <button 
                    onClick={togglePlay} 
                    className="p-3 bg-text text-background rounded-full hover:scale-110 cursor-pointer transition shadow-md flex items-center justify-center box-glow"
                    title={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? <Pause className="w-4 h-4 fill-current text-background" /> : <Play className="w-4 h-4 fill-current translate-x-0.5 text-background" />}
                  </button>
                  <button 
                    onClick={next} 
                    className="p-2 text-muted hover:text-text cursor-pointer transition hover:scale-105"
                    title="Next"
                  >
                    <SkipForward className="w-5 h-5 fill-current" />
                  </button>
                </div>

                <div className="flex items-center gap-3 w-40">
                  <Volume2 className="w-4 h-4 text-muted flex-shrink-0" />
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

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 bg-surface-elevated/40 border border-border/30 p-1 rounded-full w-fit backdrop-blur-md">
                    {SPEED_OPTIONS.map((rate) => (
                      <button
                        key={rate}
                        onClick={() => setPlaybackRate(rate)}
                        title={`Set playback speed to ${rate}x`}
                        className={`px-2.5 py-1 rounded-full text-[10px] font-semibold cursor-pointer transition ${
                          playbackRate === rate ? "bg-primary text-text shadow-sm" : "text-muted hover:text-text hover:bg-surface-elevated/60"
                        }`}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setPodcastMode("audio")}
                    className="p-2 bg-primary/20 hover:bg-primary/30 border border-primary text-primary rounded-full cursor-pointer transition hover:scale-105 shadow-md flex items-center justify-center"
                    title="Hide Video Feed"
                  >
                    <Video className="w-4 h-4 fill-current" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Episode List/Queue */}
          <div className="flex flex-col gap-4 lg:h-full lg:overflow-hidden bg-surface-elevated/10 border border-border/20 rounded-2xl p-4">
            <div className="flex justify-between items-center border-b border-border/20 pb-3">
              <h3 className="font-editorial text-text font-bold text-base">Up Next Queue</h3>
              <span className="text-[10px] text-muted font-bold">{queue.length} items</span>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-2 scrollbar-none">
              {queue.length === 0 ? (
                <p className="text-xs text-muted text-center py-8">Queue is empty</p>
              ) : (
                queue.map((s, idx) => (
                  <div
                    key={s.videoId}
                    className={`flex items-center justify-between p-2 rounded-xl transition ${
                      currentSong?.videoId === s.videoId ? "bg-primary/10 text-primary font-semibold" : "hover:bg-white/5"
                    }`}
                  >
                    <button
                      onClick={() => {
                        usePlayerStore.getState().playSong(s, queue);
                      }}
                      className="flex items-center gap-3 text-left cursor-pointer flex-grow min-w-0"
                    >
                      <SongArtwork song={s} className="w-8 h-8 rounded flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-text truncate leading-tight">{s.title}</div>
                        <div className="text-[10px] text-muted truncate">{s.artist}</div>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
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
              {playerError ? (
                <p className={`text-red-500 font-semibold animate-pulse w-full truncate transition-all ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  {playerError}
                </p>
              ) : isPlayerLoading ? (
                <p className={`text-primary font-medium w-full truncate transition-all flex items-center gap-1 ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  <Loader2 className="w-4.5 h-4.5 animate-spin" /> Loading...
                </p>
              ) : (
                <p className={`text-muted font-medium w-full truncate transition-all ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  {currentSong.artist}
                </p>
              )}
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
                    title={`Set playback speed to ${rate}x`}
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
                className={`p-2 rounded-lg cursor-pointer transition hover:scale-105 ${isShuffle ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
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
                className={`p-2 rounded-lg cursor-pointer relative transition hover:scale-105 ${repeatMode !== "none" ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
                title="Repeat Mode"
              >
                <Repeat className="w-4 h-4" />
                {repeatMode === "one" && (
                  <span className="absolute text-[7px] font-extrabold text-primary-hover translate-x-1.5 -translate-y-2">1</span>
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

              {isPodcast && (
                <button
                  disabled={!currentSong.metadata?.videoAvailable}
                  onClick={() => setPodcastMode(podcastMode === "video" ? "audio" : "video")}
                  className={`p-2 cursor-pointer transition hover:scale-105 ${
                    !currentSong.metadata?.videoAvailable
                      ? "opacity-35 cursor-not-allowed text-muted/40"
                      : podcastMode === "video"
                      ? "text-primary text-glow"
                      : "text-muted hover:text-text"
                  }`}
                  title={
                    !currentSong.metadata?.videoAvailable
                      ? "Video feed unavailable"
                      : "Toggle Video Feed"
                  }
                >
                  <Video className="w-4 h-4" />
                </button>
              )}

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
      )}

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
                <div className="flex items-center gap-3">
                  {queue.length > 0 && (
                    <button
                      onClick={() => {
                        if (currentSong) {
                          usePlayerStore.setState({ queue: [currentSong], currentIndex: 0 });
                        } else {
                          usePlayerStore.setState({ queue: [], currentIndex: -1, isPlaying: false });
                        }
                      }}
                      className="text-xs font-semibold text-red-400 hover:text-red-300 transition cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                  <button 
                    onClick={() => setShowQueue(false)} 
                    className="p-1.5 rounded-lg hover:bg-white/10 text-muted hover:text-text cursor-pointer transition"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
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

      {/* Attach Song Memory Modal */}
      <AnimatePresence>
        {showMemoryModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMemoryModal(false)}
              className="absolute inset-0 bg-background/90 backdrop-blur-md"
            />
            
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: "spring", duration: 0.35 }}
              className="relative w-full max-w-md bg-surface border border-border/80 rounded-2xl p-6 shadow-2xl space-y-6 z-10 text-left"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent/10 border border-accent/20 text-accent rounded-lg">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-editorial text-lg text-text font-bold">Attach Song Memory</h3>
                    <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mt-0.5">
                      Link your emotions to this sound
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowMemoryModal(false)}
                  className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded transition cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {memorySuccess ? (
                <div className="py-8 text-center text-accent text-sm font-semibold animate-pulse">
                  Memory attached successfully to this record.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-surface-elevated/40 border border-border/50 rounded-xl">
                    <SongArtwork song={currentSong} className="w-10 h-10 rounded shadow flex-shrink-0" />
                    <div className="min-w-0">
                      <h4 className="text-xs font-bold text-text truncate">{currentSong?.title}</h4>
                      <p className="text-[10px] text-muted truncate mt-0.5">{currentSong?.artist}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted">Your Memory Note</label>
                    <textarea
                      placeholder="What does this song remind you of? Write your note..."
                      value={memoryNote}
                      onChange={(e) => setMemoryNote(e.target.value)}
                      className="w-full h-24 bg-background border border-border rounded-xl p-3 text-xs text-text focus:outline-none focus:border-accent/50 transition resize-none font-serif leading-relaxed"
                    />
                  </div>

                  <div className="flex justify-between items-center bg-background border border-border rounded-xl p-3">
                    <div>
                      <span className="text-xs font-semibold text-text block">Visibility</span>
                      <span className="text-[10px] text-muted">Public memories appear on passport profiles</span>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setMemoryVisibility("private")}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition ${
                          memoryVisibility === "private"
                            ? "bg-accent/15 border border-accent/20 text-accent"
                            : "border border-border text-muted hover:text-text"
                        }`}
                      >
                        Private
                      </button>
                      <button
                        onClick={() => setMemoryVisibility("public")}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition ${
                          memoryVisibility === "public"
                            ? "bg-accent/15 border border-accent/20 text-accent"
                            : "border border-border text-muted hover:text-text"
                        }`}
                      >
                        Public
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => setShowMemoryModal(false)}
                      className="flex-1 py-2.5 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-xl transition cursor-pointer select-none"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveMemory}
                      disabled={!memoryNote.trim() || memorySaving}
                      className="flex-1 py-2.5 bg-accent hover:bg-accent-hover text-white text-xs font-semibold rounded-xl transition cursor-pointer select-none disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {memorySaving ? "Attaching..." : "Save Memory"}
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
