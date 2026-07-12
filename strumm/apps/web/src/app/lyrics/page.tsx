"use client";

import { useEffect, useState, useRef } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";

import { Mic2, Loader2, Music4, ArrowLeft, Play, Pause, SkipForward, SkipBack } from "lucide-react";

import { useRouter } from "next/navigation";
import { apiUrl, cleanText } from "web/lib/api";
import { getActiveLyricIndex, parseLrc, type LyricLine, unescapeHtml } from "web/lib/lyrics";

export default function LyricsPage() {
  const { currentSong, currentTime, isPlaying, togglePlay, next, prev } = usePlayerStore();
  const router = useRouter();

  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setBackdropColor] = useState<string>("rgba(255, 85, 0, 0.15)");

  const activeLineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Dynamic dominant color extraction from thumbnail
  useEffect(() => {
    if (!currentSong?.thumbnail) return;
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = currentSong.thumbnail;
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 10;
        canvas.height = 10;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 10, 10);
        const data = ctx.getImageData(0, 0, 10, 10).data;
        
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i+1];
          b += data[i+2];
        }
        const count = data.length / 4;
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        
        setBackdropColor(`rgba(${r}, ${g}, ${b}, 0.25)`);
      } catch (e) {
        console.warn("Cross-origin thumbnail color extraction restricted. Using fallback.");
      }
    };
  }, [currentSong?.thumbnail]);

  useEffect(() => {
    if (!currentSong?.videoId) return;

    if (currentSong.videoId.startsWith("podcast-")) {
      setLoading(false);
      setLyrics(null);
      setPlainLyrics("Lyrics not available for podcasts.");
      return;
    }

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
            setPlainLyrics(plain ? unescapeHtml(plain) : "Lyrics are loaded, but timestamps are missing.");
          }
        } else {
          setPlainLyrics("No lyrics found for this track.");
        }
      } catch (e) {
        setPlainLyrics("Lyrics offline. Unable to parse.");
      } finally {
        setLoading(false);
      }
    };

    fetchLyrics();
  }, [currentSong?.videoId]);

  const activeIndex = getActiveLyricIndex(lyrics, currentTime);

  const isFirstScrollRef = useRef(true);

  useEffect(() => {
    isFirstScrollRef.current = true;
  }, [currentSong?.videoId]);

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
  }, [activeIndex]);

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex flex-col justify-between p-6 md:p-12 text-white bg-black soft-enter">
      {/* Blurred album backdrop */}
      <div 
        className="absolute inset-0 bg-cover bg-center filter blur-3xl opacity-30 transition-all duration-1000 scale-110"
        style={currentSong ? { backgroundImage: `url(${currentSong.thumbnail})` } : {}}
      />
      {/* Subtle dark overlay for readability */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between border-b border-border/20 pb-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-muted hover:text-text transition text-xs font-semibold select-none cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-white" />
          Back
        </button>

        <div className="text-center">
          <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
            Now Playing Lyrics
          </span>
          {currentSong && (
            <div className="mt-1 flex items-center justify-center gap-2">
              <h1 className="font-editorial text-lg font-bold text-text truncate max-w-[200px]">
                {currentSong.title}
              </h1>
              <span className="text-muted text-xs">•</span>
              <p className="text-xs text-muted truncate max-w-[150px]">{currentSong.artist}</p>
            </div>
          )}
        </div>

        <div className="p-2 bg-primary/10 border border-primary/20 text-primary rounded-full">
          <Mic2 className="w-4 h-4 animate-pulse" />
        </div>
      </div>

      {/* Lyrics container */}
      <div 
        ref={scrollContainerRef}
        className="relative z-10 flex-1 overflow-y-auto py-12 scrollbar-none my-6 text-center max-w-4xl w-full space-y-6 md:space-y-8 px-4 flex flex-col justify-center"
      >
        {!currentSong ? (
          <div className="flex flex-col items-center justify-center text-muted gap-4 max-w-sm mx-auto p-8 bg-surface/40 border border-border/50 rounded-2xl shadow-xl backdrop-blur-md">
            <div className="p-4 bg-primary/10 border border-primary/20 text-primary rounded-full">
              <Music4 className="w-8 h-8 opacity-75" />
            </div>
            <div className="space-y-1">
              <h1 className="font-editorial text-xl text-text font-bold">Silence is Golden</h1>
              <p className="text-xs text-muted max-w-xs leading-relaxed">Queue a song to begin reading the translation.</p>
            </div>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center gap-3 text-muted">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <span className="text-xs uppercase tracking-widest">Parsing lines...</span>
          </div>
        ) : lyrics ? (
          <div className="space-y-6 md:space-y-8">
            {lyrics.map((line, idx) => {
              const isActive = idx === activeIndex;
              return (
                <div
                  key={idx}
                  ref={isActive ? activeLineRef : null}
                  className={`transition-all duration-500 py-3 leading-relaxed select-none cursor-pointer font-editorial ${
                    isActive 
                      ? "text-3xl md:text-5xl text-primary font-bold text-glow scale-105" 
                      : "text-xl md:text-3xl text-muted/30 hover:text-muted/60"
                  }`}
                >
                  {line.text}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="whitespace-pre-line py-8 text-muted/80 leading-relaxed font-editorial text-center italic text-xl md:text-3xl select-none max-w-2xl mx-auto">
            {plainLyrics}
          </div>
        )}
      </div>

      {/* Simple Player Controls at bottom of lyrics theatre */}
      {currentSong && (
        <div className="relative z-10 flex flex-col items-center gap-4 border-t border-border/20 pt-6">
          <div className="flex items-center gap-6">
            <button 
              onClick={prev}
              className="p-2 hover:bg-surface-elevated text-muted hover:text-text rounded-full transition cursor-pointer"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            
            <button 
              onClick={togglePlay}
              className="p-3.5 bg-primary hover:bg-primary-hover text-white rounded-full transition shadow-lg cursor-pointer transform hover:scale-105"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-current" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-0.5" />
              )}
            </button>

            <button 
              onClick={next}
              className="p-2 hover:bg-surface-elevated text-muted hover:text-text rounded-full transition cursor-pointer"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
