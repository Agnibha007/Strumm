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
      
      // If the jump is large (seeking), maybe instant scroll is better, but smooth usually works
      // Let's use instant if difference is large, else smooth
      const currentScroll = container.scrollTop;
      const targetScroll = elementTop - containerHeight / 2 + elementHeight / 2;
      
      container.scrollTo({
        top: targetScroll,
        behavior: Math.abs(currentScroll - targetScroll) > 300 ? "auto" : "smooth",
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
    <div className="transition-all duration-500 rounded-xl border border-border/60 bg-surface p-6 h-[450px] flex flex-col justify-between">
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
      </div>

      {/* Main scrolling content */}
      <div 
        ref={scrollContainerRef}
        className="relative flex-1 overflow-y-auto py-8 scrollbar-none my-4 space-y-4 px-2 text-left text-sm"
      >
        {loading ? (
          <div className="flex flex-col items-start h-full gap-4 py-8 animate-pulse px-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div 
                key={i} 
                className="h-6 rounded-xl bg-border/40" 
                style={{ width: `${Math.random() * 40 + 40}%` }}
              />
            ))}
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
                    ? "text-text font-editorial font-bold bg-primary/15 box-glow border border-primary/20 text-base text-primary" 
                    : "text-muted/40 hover:text-muted border border-transparent"
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
    </div>
  );
}
