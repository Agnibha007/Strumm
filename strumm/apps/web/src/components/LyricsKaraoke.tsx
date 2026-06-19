"use client";

import { useEffect, useState, useRef } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Mic2, Loader2, Music4 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl, cleanText } from "web/lib/api";
import { getActiveLyricIndex, parseLrc, type LyricLine } from "web/lib/lyrics";

export default function LyricsKaraoke() {
  const { currentSong, currentTime, isPlaying, playerRef, setCurrentTime } = usePlayerStore();
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [karaokeMode, setKaraokeMode] = useState(false);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentSong?.videoId) return;

    const fetchLyrics = async () => {
      setLoading(true);
      setLyrics(null);
      setPlainLyrics(null);
      try {
        const response = await fetch(apiUrl(`/lyrics/${encodeURIComponent(currentSong.videoId)}?title=${encodeURIComponent(cleanText(currentSong.title, 160))}&artist=${encodeURIComponent(cleanText(currentSong.artist, 160))}`));
        const json = await response.json();
        
        if (json.success && json.data) {
          const synced = json.data.synced;
          const plain = json.data.plain;
          const parsedLyrics = synced ? parseLrc(synced) : [];
          
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
        setLoading(false);
      }
    };

    fetchLyrics();
  }, [currentSong?.videoId]);

  // Find index of current playing line
  const activeIndex = getActiveLyricIndex(lyrics, currentTime);

  // Smooth scroll container to center the active line
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
  }, [activeIndex]);

  if (!currentSong) {
    return (
      <div className="flex flex-col items-center justify-center h-[350px] bg-surface/30 border border-border/40 rounded-xl p-8 text-center text-muted">
        <Music4 className="w-10 h-10 mb-3 opacity-30 animate-pulse" />
        <h3 className="font-editorial text-lg text-text mb-1">Silence is Golden</h3>
        <p className="text-xs">Queue a song to begin reading the translation.</p>
      </div>
    );
  }

  return (
    <div className={`transition-all duration-500 rounded-xl border border-border/60 ${
      karaokeMode 
        ? "fixed inset-0 z-50 bg-[#060606] border-none flex flex-col justify-between p-8 md:p-16"
        : "bg-surface p-6 h-[450px] flex flex-col justify-between"
    }`}>
      {/* Header */}
      <div className="flex justify-between items-center border-b border-border/20 pb-4">
        <div>
          <span className="text-[10px] tracking-wider uppercase font-semibold text-primary">
            Karaoke Curation
          </span>
          <h2 className="text-lg font-editorial text-text truncate max-w-[250px] md:max-w-[400px]">
            {currentSong.title}
          </h2>
          <p className="text-xs text-muted leading-none mt-1">by {currentSong.artist}</p>
        </div>
        
        <button
          onClick={() => setKaraokeMode(!karaokeMode)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold cursor-pointer transition ${
            karaokeMode
              ? "bg-primary border-primary text-white"
              : "bg-surface-elevated border-border text-text hover:border-primary/50"
          }`}
        >
          <Mic2 className="w-3.5 h-3.5" />
          {karaokeMode ? "Exit Theatre" : "Theatre Mode"}
        </button>
      </div>

      {/* Main scrolling content */}
      <div 
        ref={scrollContainerRef}
        className={`relative flex-1 overflow-y-auto py-8 scrollbar-none my-4 space-y-4 px-2 ${
          karaokeMode ? "text-center text-xl md:text-3xl max-w-4xl mx-auto w-full space-y-6" : "text-left text-sm"
        }`}
      >
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-12 text-muted">
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
                  if (playerRef) playerRef.seekTo(line.time);
                  setCurrentTime(line.time);
                }}
                className={`transition-all duration-300 py-1.5 px-3 md:px-5 rounded-2xl cursor-pointer leading-relaxed ${
                  isActive 
                    ? `text-text font-editorial font-bold bg-primary/15 box-glow border border-primary/20 ${
                        karaokeMode ? "text-3xl md:text-5xl text-primary text-glow py-3 md:py-5 scale-105" : "text-base text-primary"
                      }` 
                    : `text-muted/40 hover:text-muted border border-transparent ${
                        karaokeMode ? "font-editorial text-2xl md:text-3xl py-2" : ""
                      }`
                }`}
              >
                {line.text}
              </div>
            );
          })
        ) : (
          <div className="whitespace-pre-line py-4 text-muted/80 leading-relaxed font-editorial text-center italic text-base md:text-lg">
            {plainLyrics}
          </div>
        )}
      </div>

      {/* Close instructions for Theatre Mode */}
      {karaokeMode && (
        <div className="text-center text-[10px] text-muted tracking-widest uppercase">
          Press Exit Theatre or swipe to return to main dashboard
        </div>
      )}
    </div>
  );
}
