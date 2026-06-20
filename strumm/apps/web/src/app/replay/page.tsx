"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useThemeStore } from "web/store/useThemeStore";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import { Loader2, Music, Sparkles, Trophy, Calendar, Compass, User, Play, Clock } from "lucide-react";
import { motion } from "framer-motion";

interface ReplayData {
  totalMinutes: number;
  topSongs: Array<{
    videoId: string;
    title: string;
    artist: string;
    thumbnail: string;
    duration: number;
    count: number;
  }>;
  topArtists: Array<{
    artist: string;
    thumbnail: string;
    count: number;
  }>;
  topGenres: string[];
  favoriteTime: string;
  discoveryScore: number;
  personality: string;
  soundDNA: {
    energy: number;
    discovery: number;
    nostalgia: number;
    variety: number;
    repeatRate: number;
  };
}

export default function ReplayPage() {
  const { token } = useAuthStore();
  const { playSong } = usePlayerStore();
  const { isAnimated } = useThemeStore();
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    const fetchReplay = async () => {
      try {
        const response = await fetch(apiUrl("/replay"), {
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });
        const json = await response.json();
        if (json.success && json.data) {
          setData(json.data);
        } else {
          setError(json.error || "Failed to load Replay statistics.");
        }
      } catch (e) {
        setError("Network error. Unable to fetch your Replay.");
      } finally {
        setLoading(false);
      }
    };

    fetchReplay();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Compiling your musical passport...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center max-w-md mx-auto p-6 gap-4">
        <Trophy className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Replay Offline</h3>
        <p className="text-sm text-muted">{error || "Queue and play some tracks first to generate your custom Strumm Replay."}</p>
      </div>
    );
  }

  // Helper to draw DNA bar
  const renderDNABar = (value: number, label: string) => {
    const bars = "█".repeat(value) + "░".repeat(Math.max(0, 10 - value));
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-xs font-semibold">
          <span className="text-text">{label}</span>
          <span className="text-primary">{value * 10}%</span>
        </div>
        <div className="font-mono text-primary text-sm tracking-widest select-none">{bars}</div>
      </div>
    );
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 15 },
    show: { opacity: 1, y: 0 }
  };

  // Disable animations if battery saver mode is on
  const transitionProps = isAnimated ? {} : { duration: 0 };
  const animatedProps = isAnimated ? { initial: "hidden", animate: "show", variants: containerVariants } : {};
  const childAnimatedProps = isAnimated ? { variants: itemVariants } : {};

  return (
    <div className="max-w-6xl mx-auto space-y-10 pb-12">
      {/* Editorial Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Strumm Replay
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Your Music DNA. Always On.
        </h2>
        <p className="text-sm text-muted mt-2 max-w-2xl">
          An evolutionary analysis of your listening habits, mood fluctuations, and acoustic preference compiled in real-time.
        </p>
      </div>

      <motion.div {...animatedProps} className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Personality Box */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between relative overflow-hidden backdrop-blur-md shadow-sm hover:border-primary/30 transition"
        >
          <div className="space-y-4 z-10">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Music Personality
            </span>
            <h3 className="font-editorial text-3xl font-bold text-text leading-tight">
              {data.personality}
            </h3>
            <p className="text-xs text-muted leading-relaxed">
              Your listening timeline maps closely to this archetype. Keep exploring to evolve your profile.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 z-10 border-t border-border/20 pt-4">
            <User className="w-4 h-4 text-accent" />
            <span className="text-xs text-muted">Archived Archetype</span>
          </div>
          {/* Subtle logo vector outline behind card */}
          <div className="absolute right-[-20px] bottom-[-20px] opacity-[0.03] select-none pointer-events-none">
            <Sparkles className="w-40 h-40 text-primary" />
          </div>
        </motion.div>

        {/* Listening Minutes Box */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between backdrop-blur-md shadow-sm hover:border-primary/30 transition"
        >
          <div className="space-y-4">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Listening Time
            </span>
            <div className="flex items-baseline gap-2">
              <span className="font-editorial text-6xl font-bold text-text">{data.totalMinutes}</span>
              <span className="text-xs text-muted font-semibold uppercase tracking-wider">Minutes</span>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Calculated across your total playlist execution and session history events.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 border-t border-border/20 pt-4">
            <Clock className="w-4 h-4 text-accent" />
            <span className="text-xs text-muted">Favorite Time: {data.favoriteTime}</span>
          </div>
        </motion.div>

        {/* Discovery & Variety */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between backdrop-blur-md shadow-sm hover:border-primary/30 transition"
        >
          <div className="space-y-4">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Acoustic Metrics
            </span>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Discovery Score</span>
                <span className="text-sm font-semibold text-text">{data.discoveryScore}%</span>
              </div>
              <div className="h-1.5 w-full bg-surface-elevated rounded-full overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${data.discoveryScore}%` }} />
              </div>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              High scores signify exploration of new artists, while low scores suggest deep loyalty to standard tracks.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 border-t border-border/20 pt-4">
            <Compass className="w-4 h-4 text-accent" />
            <span className="text-xs text-muted">Top Genre: {data.topGenres[0] || "Pop / Indie"}</span>
          </div>
        </motion.div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Sound DNA Breakdown */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="font-editorial text-2xl text-text font-bold">Sound DNA</h3>
            <p className="text-xs text-muted">Visual representation of structural song tags computed from play patterns.</p>
          </div>
          <div className="space-y-4">
            {renderDNABar(data.soundDNA.energy, "Energy")}
            {renderDNABar(data.soundDNA.discovery, "Discovery")}
            {renderDNABar(data.soundDNA.nostalgia, "Nostalgia")}
            {renderDNABar(data.soundDNA.variety, "Variety")}
            {renderDNABar(data.soundDNA.repeatRate, "Repeat Rate")}
          </div>
        </div>

        {/* Top Genres and Details */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 flex flex-col justify-between gap-6">
          <div>
            <h3 className="font-editorial text-2xl text-text font-bold">Top Genres</h3>
            <p className="text-xs text-muted">The emotional frequency bands you tune into the most.</p>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {data.topGenres.map((genre, idx) => (
              <div key={genre} className="flex items-center justify-between p-3.5 bg-surface-elevated/40 border border-border/50 rounded-xl hover:border-primary/20 transition">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-muted">0{idx + 1}</span>
                  <span className="text-sm font-semibold text-text">{genre}</span>
                </div>
                <span className="text-[10px] uppercase font-mono tracking-widest text-primary font-bold">Aligned</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted border-t border-border/20 pt-4 flex justify-between">
            <span>Automatic refresh daily</span>
            <span>Based on 1000+ histories</span>
          </div>
        </div>
      </div>

      {/* Top Songs */}
      <div className="space-y-4">
        <h3 className="font-editorial text-2xl text-text font-bold">Your Heavy Rotation</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.topSongs.map((song, idx) => (
            <button
              key={song.videoId}
              onClick={() => playSong(song as any, data.topSongs as any)}
              className="flex items-center justify-between p-4 bg-surface/40 hover:bg-surface-elevated/50 border border-border/60 rounded-xl text-left w-full cursor-pointer transition border border-transparent hover:border-primary/30"
            >
              <div className="flex items-center gap-4 min-w-0">
                <span className="text-sm font-mono text-muted w-5 flex-shrink-0">0{idx + 1}</span>
                <SongArtwork song={song} className="w-12 h-12 rounded shadow flex-shrink-0" />
                <div className="min-w-0">
                  <h4 className="text-sm font-bold text-text truncate leading-snug">{song.title}</h4>
                  <p className="text-xs text-muted truncate mt-0.5">{song.artist}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right">
                  <span className="text-xs font-bold text-primary">{song.count} plays</span>
                </div>
                <Play className="w-4 h-4 text-muted fill-current hover:text-primary transition" />
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Top Artists */}
      <div className="space-y-4">
        <h3 className="font-editorial text-2xl text-text font-bold">Top Artists</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {data.topArtists.map((artist, idx) => (
            <div
              key={artist.artist}
              className="p-4 bg-surface/40 border border-border/60 rounded-xl text-center flex flex-col items-center gap-3 hover:border-primary/30 transition"
            >
              {artist.thumbnail ? (
                <img src={artist.thumbnail} loading="lazy" decoding="async" alt={artist.artist} className="w-20 h-20 rounded-full object-cover shadow border border-border/40" />
              ) : (
                <div className="w-20 h-20 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                  <Music className="w-8 h-8 text-accent opacity-50" />
                </div>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-text truncate leading-tight w-full px-2">{artist.artist}</h4>
                <p className="text-xs text-muted mt-1 font-semibold">{artist.count} plays</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
