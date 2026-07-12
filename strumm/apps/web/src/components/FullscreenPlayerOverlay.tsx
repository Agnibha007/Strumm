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
  Heart,
  ListMusic,
  Trash2,
  ChevronUp,
  ChevronDown,
  X,
  Video,
  Sparkles,
  Radio,
  Clock,
  Music
} from "lucide-react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import { apiUrl, cleanText } from "web/lib/api";
import { formatTime } from "web/lib/format";
import { useLikeSong } from "web/hooks/useLikeSong";
import { getActiveLyricIndex, parseLrc, type LyricLine, unescapeHtml } from "web/lib/lyrics";
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
    podcastMode,
    setPodcastMode,
    playerError,
    isPlayerLoading,
    isRadio,
    triggerRadio,
    sleepTimerDuration,
    sleepTimerEndTime,
    setSleepTimer,
    clearSleepTimer,
  } = usePlayerStore();
  const { token, user } = useAuthStore();
  const { isLiked, toggleLike } = useLikeSong(currentSong?.videoId, token);


  // ---- Local state & refs (moved BEFORE the early return to comply with Rules of Hooks) ----

  const { isAnimated } = useThemeStore();
  const router = useRouter();

  const [showQueue, setShowQueue] = useState(false);
  const [showSleepTimer, setShowSleepTimer] = useState(false);
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
  const [copied, setCopied] = useState(false);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isFirstScrollRef = useRef(true);

  // ---- Effects (also moved before the early return) ----

  // Restore lyrics preference from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem("strumm-show-lyrics");
      if (cached !== null) {
        setShowLyrics(cached === "true");
      }
    }
  }, []);

  // Escape key closes the overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Push history state for the current song
  useEffect(() => {
    if (typeof window === "undefined" || !currentSong?.videoId) return;

    const originalPath = window.location.pathname + window.location.search;
    const songId = currentSong.videoId;
    const isPodcastEp = songId.startsWith("podcast-");
    
    const targetPath = isPodcastEp 
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

  // Fetch lyrics on song load
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
            setPlainLyrics(plain ? unescapeHtml(plain) : "Lyrics are synced to sound, but timestamps are missing.");
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

  useEffect(() => {
    isFirstScrollRef.current = true;
  }, [currentSong?.videoId, showLyrics]);

  // ---- Computed values (safe before early return — store defaults exist) ----
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const activeIndex = getActiveLyricIndex(lyrics, currentTime);

  // Scroll active lyric line to center
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

  // ---- Early return (after all hooks) ----
  if (!currentSong) return null;

  // ---- Derived values (require currentSong to be non-null) ----
  const isPodcast = currentSong.videoId.startsWith("podcast-");

  const effectiveShowLyrics = showLyrics && !isPodcast;

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

  const handleSaveMemory = async () => {
    if (!currentSong || !user) return;
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

  const handleShare = async () => {
    if (typeof window === "undefined" || !currentSong) return;
    
    const isPodcastEp = currentSong.videoId.startsWith("podcast-");
    const sharePath = isPodcastEp 
      ? `/podcast/${currentSong.videoId.substring("podcast-".length)}` 
      : `/song/${currentSong.videoId}`;
      
    const shareUrl = `${window.location.origin}${sharePath}`;
    const shareData = {
      title: currentSong.title,
      text: `Listen to \"${currentSong.title}\" by ${currentSong.artist} on Strumm`,
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

  return (
    <motion.div
        initial={{ backdropFilter: "blur(0px)" }}
        animate={{ backdropFilter: "blur(24px)" }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className={`fixed inset-0 z-50 bg-background/95 flex flex-col p-4 md:p-6 lg:p-8 xl:p-12 text-text overflow-x-hidden select-none transition-all ${effectiveShowLyrics ? "overflow-y-hidden" : "overflow-y-auto"}`}
      >
      {/* Header bar */}        <div className="flex justify-between items-start md:items-center z-10 flex-shrink-0 border-b border-border/20 pb-3 md:pb-4 gap-2 max-w-7xl w-full mx-auto">
        <button 
          onClick={onClose} 
          className="flex items-center gap-1.5 md:gap-2 text-muted hover:text-text cursor-pointer group transition flex-shrink-0"
          aria-label="Minimize player"
        >
          <Minimize2 className="w-4 h-4 md:w-5 md:h-5 group-hover:scale-110 transition-transform" />
          <span className="text-[10px] md:text-xs uppercase tracking-wider font-semibold">Minimize</span>
        </button>

        <div className="text-center hidden md:block flex-shrink min-w-0 px-2">
          <span className="text-[9px] tracking-widest uppercase font-semibold text-muted">Now Playing</span>
          <h3 className="text-xs font-semibold tracking-wide text-text/80 truncate max-w-[120px] lg:max-w-[200px] xl:max-w-[400px] mt-0.5">
            {currentSong.metadata?.album || "Strumm Ecosystem"}
          </h3>
        </div>

        <div className="flex items-center gap-1.5 md:gap-2 flex-wrap justify-end">
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
              aria-pressed={effectiveShowLyrics}
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
            aria-pressed={isLiked}
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

          {/* Sleep Timer Button */}
          <button
            onClick={() => setShowSleepTimer(!showSleepTimer)}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-bold cursor-pointer transition-all ${
              sleepTimerDuration
                ? "bg-amber-500/20 border-amber-500 text-amber-400 shadow-md box-glow"
                : "border-border/30 bg-surface-elevated/40 text-muted hover:text-text hover:border-primary/50"
            }`}
            title={sleepTimerDuration ? "Sleep Timer Active" : "Set Sleep Timer"}
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{sleepTimerDuration ? "Sleep" : "Sleep"}</span>
          </button>
        </div>
      </div>

      {/* Audio/Lyrics Mode View */}
        <div className={`w-full flex-1 mt-3 md:mt-6 min-h-0 z-10 max-w-7xl mx-auto transition-all duration-500 ${
          effectiveShowLyrics 
            ? "flex flex-col lg:grid lg:grid-cols-2 gap-3 lg:gap-8 xl:gap-16 h-full min-h-0" 
            : "flex flex-col items-center justify-center max-w-2xl"
        }`}>
          
          {/* Left Side: Song Details & Controls */}
          <div className={`flex flex-col items-center w-full transition-all duration-500 ${
            effectiveShowLyrics 
              ? "gap-2 lg:gap-4 xl:gap-6 lg:items-center text-center flex-shrink-0" 
              : "gap-6 items-center text-center"
          }`}>
            
            {/* Album Cover Card */}
            <div className={`relative group flex items-center justify-center ${effectiveShowLyrics ? "hidden lg:block" : "flex"}`}>
              <div
                className={`overflow-hidden rounded-2xl md:rounded-3xl border border-border/40 relative shadow-[0_25px_60px_rgba(0,0,0,0.65)] bg-surface-elevated transition-all duration-500 max-w-full ${
                  effectiveShowLyrics 
                    ? "w-48 h-48 md:w-56 md:h-56 lg:w-72 lg:h-72 xl:w-80 xl:h-80" 
                    : "w-[70vw] h-[70vw] sm:w-72 sm:h-72 md:w-80 md:h-80 lg:w-96 lg:h-96 xl:w-[420px] xl:h-[420px]"
                }`}
              >
                <SongArtwork song={currentSong} className="w-full h-full rounded-2xl md:rounded-3xl" iconClassName="w-14 h-14" priority sizes="(max-width: 640px) 70vw, (max-width: 768px) 288px, (max-width: 1024px) 320px, 384px" />
              </div>
            </div>

            {/* Song title and artist — wrap naturally instead of truncating */}
            <div className="w-full min-w-0 px-2 break-words">
              <h2 className={`font-editorial font-bold text-text leading-tight tracking-tight mb-1 w-full whitespace-normal transition-all ${effectiveShowLyrics ? "text-xl md:text-3xl lg:text-5xl" : "text-2xl md:text-4xl lg:text-5xl"}`}>
                {currentSong.title}
              </h2>
              {playerError ? (
                <p className={`text-red-500 font-semibold animate-pulse w-full whitespace-normal transition-all ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  {playerError}
                </p>
              ) : isPlayerLoading ? (
                <p className={`text-primary font-medium w-full whitespace-normal transition-all flex items-center gap-1 ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  <Loader2 className="w-4.5 h-4.5 animate-spin" /> Loading...
                </p>
              ) : (
                <p className={`text-muted font-medium w-full whitespace-normal transition-all ${effectiveShowLyrics ? "text-xs md:text-sm lg:text-base" : "text-sm md:text-base"}`}>
                  {currentSong.artist}
                </p>
              )}
            </div>

            {/* Playback speed selector */}
            <div className={`flex flex-col items-center gap-1.5 w-full transition-all ${
              effectiveShowLyrics ? "hidden lg:flex lg:items-center" : "flex items-center"
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
              effectiveShowLyrics ? "lg:justify-center" : "justify-center"
            }`}>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.85 }}
                onClick={() => setShuffle(!isShuffle)}
                className={`p-2 rounded-lg cursor-pointer transition ${isShuffle ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
                aria-pressed={isShuffle}
                title="Shuffle"
              >
                <Shuffle className="w-4 h-4" />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.85 }}
                onClick={prev} 
                className="p-2 text-muted hover:text-text cursor-pointer transition"
                aria-label="Previous track"
                title="Previous"
              >
                <SkipBack className="w-5 h-5 fill-current" />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.12 }}
                whileTap={{ scale: 0.88 }}
                onClick={togglePlay} 
                className="p-4 bg-text text-background rounded-full cursor-pointer transition shadow-xl flex items-center justify-center box-glow"
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <Pause className="w-5 h-5 fill-current text-background" />
                ) : (
                  <Play className="w-5 h-5 fill-current translate-x-0.5 text-background" />
                )}
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.85 }}
                onClick={next} 
                className="p-2 text-muted hover:text-text cursor-pointer transition"
                aria-label="Next track"
                title="Next"
              >
                <SkipForward className="w-5 h-5 fill-current" />
              </motion.button>
              
              <button
                onClick={() => setRepeatMode(repeatMode === "none" ? "all" : repeatMode === "all" ? "one" : "none")}
                className={`p-2 rounded-lg cursor-pointer relative transition hover:scale-105 ${repeatMode !== "none" ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
                aria-label={`Repeat mode: ${repeatMode === "none" ? "off" : repeatMode === "all" ? "all" : "one"}`}
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
              effectiveShowLyrics ? "hidden lg:flex lg:justify-center" : "flex justify-center"
            }`}>

              <button
                onClick={handleShare}
                className={`p-2 cursor-pointer transition hover:scale-105 ${copied ? "text-primary text-glow animate-pulse" : "text-muted hover:text-text"}`}
                title={copied ? "Link Copied!" : "Share track"}
              >
                {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
              </button>

              <AddToPlaylistMenu song={currentSong} className="!p-0 !bg-transparent hover:!bg-transparent hover:scale-105" />

              {!isPodcast && (
                <button
                  onClick={() => currentSong && triggerRadio(currentSong.videoId)}
                  className={`p-2 cursor-pointer transition hover:scale-105 ${
                    isRadio
                      ? "text-primary text-glow"
                      : "text-muted hover:text-text"
                  }`}
                  title={isRadio ? "Radio active" : "Start Radio from this song"}
                >
                  <Radio className="w-4 h-4" />
                </button>
              )}



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

            {/* Volume control */}
            <div className={`flex items-center gap-3 w-full max-w-[200px] mt-1 justify-center transition-all ${
              effectiveShowLyrics ? "hidden lg:flex lg:justify-center" : "flex justify-center"
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
            <div className="flex flex-col lg:h-full bg-surface-elevated/20 border border-border/30 rounded-3xl p-3 md:p-4 lg:p-6 min-h-0 overflow-hidden backdrop-blur-md w-full transition-all">
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
                className="flex-1 overflow-y-auto pr-1 md:pr-2 space-y-3 md:space-y-4 lg:space-y-5 text-center min-h-0"
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setShowQueue(false)}
              className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: 0.2 }}
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
          </motion.div>
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

      {/* Sleep Timer Popover */}
      <AnimatePresence>
        {showSleepTimer && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3 }}
            className="fixed inset-0 z-[1000] flex items-end justify-center p-4 md:items-center md:justify-center pointer-events-none"
          >
            <div className="absolute inset-0 bg-background/60 backdrop-blur-sm pointer-events-auto" onClick={() => setShowSleepTimer(false)} />
            <motion.div
              className="relative w-full max-w-sm bg-surface border border-border/80 rounded-2xl p-5 shadow-2xl pointer-events-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-lg">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-editorial text-lg text-text font-bold">Sleep Timer</h3>
                    <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mt-0.5">
                      Stop playback after
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowSleepTimer(false)}
                  className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded transition cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              {sleepTimerEndTime && sleepTimerDuration && (
                <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center justify-between">
                  <div>
                    <p className="text-xs text-amber-400 font-semibold">Active Timer</p>
                    <p className="text-sm text-amber-300 font-bold mt-0.5">
                      {sleepTimerDuration === "end-of-track"
                        ? "End of current track"
                        : `${sleepTimerDuration} minutes`}
                    </p>
                    <p className="text-[10px] text-amber-500/80 mt-0.5">
                      Stops at {new Date(sleepTimerEndTime).toLocaleTimeString()}
                    </p>
                  </div>
                  <button
                    onClick={clearSleepTimer}
                    className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500 text-amber-400 text-[10px] font-bold rounded-lg transition cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 mb-3">
                {([15, 30, 45, 60] as const).map((mins) => (
                  <button
                    key={mins}
                    onClick={() => setSleepTimer(mins)}
                    className={`p-3 rounded-xl border transition cursor-pointer ${
                      sleepTimerDuration === mins
                        ? "bg-primary/20 border-primary text-primary shadow-md box-glow"
                        : "bg-surface-elevated/40 border-border/30 text-muted hover:text-text hover:border-primary/50"
                    }`}
                  >
                    <span className="text-lg font-bold block">{mins} min</span>
                    <span className="text-[10px] block mt-0.5">
                      {new Date(Date.now() + mins * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                ))}
              </div>

              <button
                onClick={() => setSleepTimer("end-of-track")}
                className={`w-full p-3 rounded-xl border transition cursor-pointer ${
                  sleepTimerDuration === "end-of-track"
                    ? "bg-primary/20 border-primary text-primary shadow-md box-glow"
                    : "bg-surface-elevated/40 border-border/30 text-muted hover:text-text hover:border-primary/50"
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  <span className="w-5 h-5 flex items-center justify-center">
                    <Music className="w-5 h-5" />
                  </span>
                  <span className="font-bold">End of Track</span>
                </div>
                {currentSong && (
                  <span className="text-[10px] block text-muted text-center mt-0.5">
                    ~{Math.ceil((duration - currentTime) / 60)} min remaining
                  </span>
                )}
              </button>

              <button
                onClick={clearSleepTimer}
                disabled={!sleepTimerDuration}
                className="w-full mt-3 py-2.5 border border-border hover:bg-surface-elevated text-muted hover:text-text text-xs font-semibold rounded-xl transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed select-none"
              >
                Clear Timer
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
