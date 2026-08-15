"use client";

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useThemeStore } from "web/store/useThemeStore";
import { useAuthStore } from "web/store/useAuthStore";
import { Play, Pause, SkipForward, SkipBack, Shuffle, Repeat, Volume2, ListMusic, Maximize, Heart, Trash2, ChevronUp, ChevronDown, Loader2, Clock } from "lucide-react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import dynamic from "next/dynamic";
import { apiUrl, cleanText } from "web/lib/api";
import { formatTime } from "web/lib/format";
import { useLikeSong } from "web/hooks/useLikeSong";
import SongArtwork from "web/components/SongArtwork";
import AddToPlaylistMenu from "./AddToPlaylistMenu";

const FullscreenPlayerOverlay = dynamic(() => import("./FullscreenPlayerOverlay"), {
  loading: () => (
    <div className="fixed inset-0 bg-background/90 z-[90] flex flex-col items-center justify-center gap-2">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  ),
  ssr: false,
});

export default function EditorialPlayer() {
  // Granular selectors to minimize re-renders:
  // currentTime changes every 250ms — isolate it from other state
  const currentTime = usePlayerStore((s) => s.currentTime);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const duration = usePlayerStore((s) => s.duration);

  // Static/rarely-changing state
  const currentSong = usePlayerStore((s) => s.currentSong);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const isShuffle = usePlayerStore((s) => s.isShuffle);
  const podcastMode = usePlayerStore((s) => s.podcastMode);
  const playerError = usePlayerStore((s) => s.playerError);
  const isPlayerLoading = usePlayerStore((s) => s.isPlayerLoading);

  // Frequently-changing derived state
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);

  // Actions (stable references — safe to batch)
  const playerRef = usePlayerStore((s) => s.playerRef);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setShuffle = usePlayerStore((s) => s.setShuffle);
  const setRepeatMode = usePlayerStore((s) => s.setRepeatMode);

  const { token } = useAuthStore();

  const { isAnimated } = useThemeStore();
  const [showQueue, setShowQueue] = useState(false);
  const [, setIsFullscreen] = useState(false);
  const [showFullscreenMenu, setShowFullscreenMenu] = useState(false);
  const showFullscreenMenuRef = useRef(false);
  const pendingFullscreenExitRef = useRef(false);
  const { isLiked, toggleLike } = useLikeSong(currentSong?.videoId, token);
  const sleepTimerDuration = usePlayerStore((s) => s.sleepTimerDuration);
  const sleepTimerEndTime = usePlayerStore((s) => s.sleepTimerEndTime);
  const lastAutoOpenedVideoId = useRef<string | null>(null);

  useEffect(() => {
    const shouldOpenPodcastVideo =
      currentSong?.videoId?.startsWith("podcast-") &&
      currentSong.metadata?.videoAvailable &&
      podcastMode === "video";

    if (shouldOpenPodcastVideo && currentSong && lastAutoOpenedVideoId.current !== currentSong.videoId) {
      lastAutoOpenedVideoId.current = currentSong.videoId;
      openFullscreenPlayer();
    }
  }, [currentSong?.videoId, currentSong?.metadata?.videoAvailable, podcastMode]);

  useEffect(() => {
    showFullscreenMenuRef.current = showFullscreenMenu;
  }, [showFullscreenMenu]);

  const openFullscreenPlayer = async () => {
    setShowFullscreenMenu(true);
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen API unavailable (e.g. iOS Safari); the in-page overlay still opens.
    }
  };

  const closeFullscreenPlayer = async () => {
    pendingFullscreenExitRef.current = true;
    setShowFullscreenMenu(false);
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      // ignore
    }
    setTimeout(() => {
      pendingFullscreenExitRef.current = false;
    }, 150);
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!document.fullscreenElement;
      setIsFullscreen(isFs);
      if (!isFs && !pendingFullscreenExitRef.current && showFullscreenMenuRef.current) {
        setShowFullscreenMenu(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Sync listening stats to backend every 30 seconds of active playback.
  // A ref accumulator (not React state) drives the counter: side effects in
  // state updaters are re-run by React StrictMode/concurrent rendering, which
  // double-counts play events. The token is read fresh from the store at send
  // time so an access-token rotation mid-session can't 401 every sync, and
  // partial seconds are flushed on pause/track-change/unmount so short listening
  // bursts still count toward the user's minutes.
  const listenAccumulatorRef = useRef(0);

  const syncListeningStats = async (song: any, durationSec: number) => {
    const { token, fetchProfile } = useAuthStore.getState();
    try {
      const response = await fetch(apiUrl("/play-event"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token || ""}`
        },
        body: JSON.stringify({
          song: {
            videoId: song.videoId,
            title: cleanText(song.title || "", 160),
            artist: cleanText(song.artist || "", 160),
            thumbnail: cleanText(song.thumbnail || "", 500),
            duration: Math.round(song.duration) || 180
          },
          listenDuration: durationSec
        })
      });
      const json = await response.json().catch(() => null);
      if (json?.success) {
        fetchProfile();
      }
    } catch (e) {
      console.warn("Playback statistics failed to sync offline.");
    }
  };

  useEffect(() => {
    if (!isPlaying || !currentSong) return;
    const song = currentSong;
    const timer = setInterval(() => {
      listenAccumulatorRef.current += 1;
      if (listenAccumulatorRef.current >= 30) {
        const secs = 30;
        listenAccumulatorRef.current -= 30;
        syncListeningStats(song, secs);
      }
    }, 1000);

    return () => {
      clearInterval(timer);
      const partial = listenAccumulatorRef.current;
      if (partial > 0) {
        listenAccumulatorRef.current = 0;
        syncListeningStats(song, partial);
      }
    };
  }, [isPlaying, currentSong?.videoId]);

  if (!currentSong) return null;

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

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerRef || duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const clickRatio = clickX / width;
    const seekTime = clickRatio * duration;
    playerRef.seekTo(seekTime);
    setCurrentTime(seekTime);
  };

  return (
    <>
      <div className="fixed bottom-[64px] md:bottom-0 left-0 md:left-64 right-0 z-40 bg-surface/90 backdrop-blur-xl border-t border-border/60 px-3 sm:px-4 md:px-8 py-3 md:py-4">
        {/* Mobile thin top playbar */}
        <div 
          onClick={handleProgressClick}
          className="absolute top-0 left-0 right-0 h-[3px] bg-border/25 cursor-pointer md:hidden"
        >
          <div 
            style={{ width: `${progressPercent}%` }} 
            className="h-full bg-primary" 
          />
        </div>
        
        <div className="max-w-7xl flex md:grid md:grid-cols-[minmax(0,1fr)_minmax(280px,1.2fr)_minmax(0,1fr)] items-center justify-between gap-3 md:gap-4">
          
          {/* Left: Song details */}
          <div 
            className="flex items-center gap-3 md:gap-4 min-w-0 flex-1 md:w-full cursor-pointer md:cursor-auto"
            onClick={() => {
              if (window.innerWidth < 768) {
                openFullscreenPlayer();
              }
            }}
          >
            <motion.div 
              animate={isAnimated && isPlaying ? { rotate: 360 } : {}}
              transition={isAnimated && isPlaying ? { repeat: Infinity, duration: 15, ease: "linear" } : {}}
              className="w-11 h-11 md:w-12 md:h-12 rounded-full overflow-hidden border border-border/80 flex-shrink-0 relative shadow-lg bg-surface-elevated"
            >
              <SongArtwork song={currentSong} className="w-full h-full" />
              <div className="absolute inset-4 rounded-full bg-background border border-border/40" /> {/* Vinyl hole effect */}
            </motion.div>
            
            <div className="min-w-0 flex-1 overflow-hidden pr-2">
              <h4 className="font-editorial text-text text-base leading-tight truncate font-bold w-full">
                {currentSong.title}
              </h4>
              {playerError ? (
                <p className="text-xs text-red-500 font-semibold animate-pulse leading-tight truncate mt-0.5 w-full">
                  {playerError}
                </p>
              ) : isPlayerLoading ? (
                <p className="text-xs text-primary leading-tight truncate mt-0.5 w-full flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </p>
              ) : (
                <p className="text-xs text-muted leading-tight truncate mt-0.5 w-full">{currentSong.artist}</p>
              )}
            </div>
          </div>

          {/* Middle: Controls & progress */}
          <div className="flex flex-col items-center gap-2 flex-shrink-0 md:w-full">
            <div className="flex items-center justify-center gap-4 sm:gap-5">
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => setShuffle(!isShuffle)}
                disabled={repeatMode === "one"}
                title={repeatMode === "one" ? "Turn off Repeat One to use Shuffle" : isShuffle ? "Disable Shuffle" : "Enable Shuffle"}
                className={`hidden md:block p-1.5 rounded-lg cursor-pointer transition ${repeatMode === "one" ? "opacity-40 cursor-not-allowed text-muted" : isShuffle ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
              >
                <Shuffle className="w-3.5 h-3.5" />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                onClick={prev} 
                title="Previous Track"
                className="hidden md:block p-1.5 text-muted hover:text-text cursor-pointer transition"
              >
                <SkipBack className="w-4 h-4 fill-current" />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={togglePlay} 
                title={isPlaying ? "Pause" : "Play"}
                className="p-3 bg-text text-background rounded-full cursor-pointer transition shadow-md"
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current text-background" /> : <Play className="w-4 h-4 fill-current translate-x-0.5 text-background" />}
              </motion.button>

              <button
                onClick={(e) => { e.stopPropagation(); setShowQueue(!showQueue); }}
                className="md:hidden p-2 text-muted hover:text-text cursor-pointer transition"
                title="Queue"
              >
                <ListMusic className="w-4.5 h-4.5" />
              </button>
              
              <motion.button 
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                onClick={next} 
                title="Next Track"
                className="hidden md:block p-1.5 text-muted hover:text-text cursor-pointer transition"
              >
                <SkipForward className="w-4 h-4 fill-current" />
              </motion.button>

              <button
                onClick={() => setRepeatMode(repeatMode === "none" ? "all" : repeatMode === "all" ? "one" : "none")}
                title={`Repeat Mode: ${repeatMode === "none" ? "Off" : repeatMode === "all" ? "Repeat All" : "Repeat One"}`}
                className={`hidden md:block p-1.5 rounded-lg cursor-pointer transition relative ${repeatMode !== "none" ? "bg-primary/25 text-primary-hover border border-primary/30 text-glow" : "text-muted hover:text-text border border-transparent"}`}
              >
                <Repeat className="w-3.5 h-3.5" />
                {repeatMode === "one" && <span className="absolute text-[8px] font-bold text-primary-hover translate-x-2 -translate-y-2">1</span>}
              </button>
            </div>

            {/* Progress scrubber */}
            <div className="hidden md:flex items-center gap-2 w-full text-[10px] text-muted font-semibold">
              <span>{formatTime(currentTime)}</span>
              <div 
                onClick={handleProgressClick}
                className="flex-1 h-1 bg-border/80 hover:h-1.5 rounded-full cursor-pointer relative transition-all"
              >
                <div 
                  style={{ width: `${progressPercent}%` }} 
                  className="absolute top-0 bottom-0 left-0 bg-primary rounded-full box-glow" 
                />
              </div>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Right: Volume & Queue */}
          <div className="hidden md:flex items-center justify-center md:justify-end gap-3 md:gap-4 w-full">
            <div className="hidden sm:flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-muted" />
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-20 h-1 bg-border/80 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none"
              />
            </div>
            
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (currentSong) toggleLike(currentSong).catch(console.error);
              }}
              className={`p-2 rounded hover:bg-surface-elevated cursor-pointer transition ${isLiked ? "text-primary text-glow" : "text-muted hover:text-text"}`}
              title={isLiked ? "Unlike" : "Like"}
            >
              <Heart className={`w-4 h-4 ${isLiked ? "fill-current" : ""}`} />
            </button>

            <AddToPlaylistMenu song={currentSong} />

            {/* Sleep Timer Indicator */}
            {sleepTimerDuration && sleepTimerEndTime && (
              <div className="relative">
                <button
                  onClick={() => openFullscreenPlayer()}
                  className="p-2 rounded hover:bg-surface-elevated cursor-pointer transition text-primary text-glow"
                  title={`Sleep timer: ${sleepTimerDuration === "end-of-track" ? "End of track" : `${sleepTimerDuration} min`}`}
                >
                  <Clock className="w-4 h-4 animate-pulse" />
                </button>
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-primary text-background text-[8px] font-bold rounded-full flex items-center justify-center">
                  {sleepTimerDuration === "end-of-track" ? "♪" : String(sleepTimerDuration).slice(-1)}
                </span>
              </div>
            )}

            <button
              onClick={() => openFullscreenPlayer()}
              className="p-2 rounded hover:bg-surface-elevated cursor-pointer transition text-muted hover:text-text"
              title="Fullscreen Mode"
            >
              <Maximize className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowQueue(!showQueue)}
              title={showQueue ? "Hide Queue" : "Show Queue"}
              className={`p-2 rounded hover:bg-surface-elevated cursor-pointer transition ${showQueue ? "text-primary" : "text-muted hover:text-text"}`}
            >
              <ListMusic className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Queue Drawer overlay */}
        <AnimatePresence>
          {showQueue && (
            <motion.div 
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              transition={{ duration: 0.2 }}
              className="absolute bottom-28 md:bottom-20 right-3 left-3 md:left-auto md:right-8 bg-surface-elevated border border-border/80 rounded-xl p-4 md:w-[320px] max-h-[350px] overflow-y-auto shadow-2xl flex flex-col gap-2"
            >
              <div className="border-b border-border/20 pb-2 mb-1 flex justify-between items-center">
                <h5 className="font-editorial text-text font-bold text-sm">Up Next ({queue.length})</h5>
                <div className="flex items-center gap-2">
                  {queue.length > 0 && (
                    <button
                      onClick={() => {
                        if (currentSong) {
                          usePlayerStore.setState({ queue: [currentSong], currentIndex: 0 });
                        } else {
                          usePlayerStore.setState({ queue: [], currentIndex: -1, isPlaying: false });
                        }
                      }}
                      className="text-[10px] uppercase text-red-400 hover:text-red-300 transition cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                  {queue.length > 0 && <span className="text-[10px] text-muted/40">|</span>}
                  <button onClick={() => setShowQueue(false)} className="text-[10px] uppercase text-muted hover:text-text cursor-pointer">Close</button>
                </div>
              </div>
              
              {queue.length === 0 ? (
                <p className="text-xs text-muted text-center py-4">Queue is empty</p>
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
                  className="flex flex-col gap-2 overflow-y-auto max-h-[280px]"
                >
                  {queue.map((s, idx) => (
                    <Reorder.Item
                      key={s.videoId}
                      value={s}
                      className={`flex items-center justify-between p-1.5 rounded transition w-full ${
                        currentSong.videoId === s.videoId ? "bg-primary/5 text-primary font-semibold" : "hover:bg-background/40"
                      } cursor-grab active:cursor-grabbing select-none`}
                    >
                      <button
                        onClick={() => {
                          usePlayerStore.getState().playSong(s, queue);
                        }}
                        className="flex items-center gap-3 text-left cursor-pointer flex-grow min-w-0 pointer-events-auto"
                      >
                        <SongArtwork song={s} className="w-7 h-7 rounded flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] text-text truncate leading-tight">{s.title}</div>
                          <div className="text-[9px] text-muted truncate">{s.artist}</div>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-2 pointer-events-auto">
                        <button
                          disabled={idx === 0}
                          onClick={(e) => { e.stopPropagation(); moveSong(idx, idx - 1); }}
                          className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition text-muted hover:text-text"
                          title="Move Up"
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          disabled={idx === queue.length - 1}
                          onClick={(e) => { e.stopPropagation(); moveSong(idx, idx + 1); }}
                          className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer transition text-muted hover:text-text"
                          title="Move Down"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeSong(idx); }}
                          className="p-1 rounded hover:bg-red-500/10 cursor-pointer transition text-muted hover:text-red-400"
                          title="Remove"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </Reorder.Item>
                  ))}
                </Reorder.Group>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Fullscreen Player Menu */}
      <AnimatePresence>
        {showFullscreenMenu && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: "spring", duration: 0.4, bounce: 0.12 }}
            className="fixed inset-0 z-[9999]"
          >
            <FullscreenPlayerOverlay onClose={closeFullscreenPlayer} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
