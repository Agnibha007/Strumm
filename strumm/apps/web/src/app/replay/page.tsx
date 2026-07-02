"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useThemeStore } from "web/store/useThemeStore";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import SoundDNAChart from "web/components/SoundDNAChart";
import { Loader2, Music, Sparkles, Trophy, Compass, User, Play, Clock } from "lucide-react";
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
    plays: number;
    minutes: number;
  }>;
  topArtists: Array<{
    artist: string;
    thumbnail: string;
    count: number;
    plays: number;
    minutes: number;
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
  insufficientHistory: boolean;
}

const formatArtists = (artistStr: string) => {
  if (!artistStr) return "Unknown Artist";
  const artists = artistStr.split(/,\s*/);
  if (artists.length <= 2) {
    return artistStr;
  }
  return `${artists[0]}, ${artists[1]} +${artists.length - 2} more`;
};

export default function ReplayPage() {
  const { token } = useAuthStore();
  const { playSong } = usePlayerStore();
  const { isAnimated } = useThemeStore();
  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const fetchReplay = useCallback(async () => {
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
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchReplay();
  }, [token, fetchReplay]);

  const handleRecalculateLive = async () => {
    if (!token) return;
    setRecalculating(true);
    try {
      const response = await fetch(apiUrl("/profile/recalculate"), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      const json = await response.json();
      if (json.success) {
        await fetchReplay();
      } else {
        alert(json.error || "Failed to recalculate statistics.");
      }
    } catch (e) {
      alert("Network error. Unable to recalculate live.");
    } finally {
      setRecalculating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Compiling your musical passport...</span>
      </div>
    );
  }

  // Empty state handling
  if (error || !data || data.insufficientHistory) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center max-w-md mx-auto p-6 gap-4">
        <Trophy className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Your Replay is warming up</h3>
        <p className="text-sm text-muted">{error || "Listen to songs to discover your Sound DNA"}</p>
        <button
          onClick={handleRecalculateLive}
          disabled={recalculating}
          className="flex items-center justify-center gap-2 px-6 py-2.5 bg-primary/10 hover:bg-primary/20 border border-primary/30 hover:border-primary/50 text-primary text-xs uppercase tracking-widest font-semibold rounded-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed mt-2 shadow-[0_0_15px_rgba(var(--color-primary),0.05)]"
        >
          {recalculating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Recalculating...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span>Recalculate Live</span>
            </>
          )}
        </button>
      </div>
    );
  }

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

  const animatedProps = isAnimated ? { initial: "hidden", animate: "show", variants: containerVariants } : {};
  const childAnimatedProps = isAnimated ? { variants: itemVariants } : {};

  return (
    <div className="max-w-6xl mx-auto space-y-10 pb-12 w-full px-4 md:px-0 min-w-0 overflow-hidden">
      {/* Editorial Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 min-w-0">
        <div className="min-w-0 flex-1">
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Strumm Replay
          </span>
          <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1 truncate max-w-full">
            Your Music DNA. Always On.
          </h2>
          <p className="text-sm text-muted mt-2 max-w-2xl line-clamp-2 overflow-hidden">
            An evolutionary analysis of your listening habits, mood fluctuations, and acoustic preference compiled in real-time.
          </p>
        </div>
        <button
          onClick={handleRecalculateLive}
          disabled={recalculating}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-primary/10 hover:bg-primary/20 border border-primary/30 hover:border-primary/50 text-primary text-xs uppercase tracking-widest font-semibold rounded-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed h-9 w-full sm:w-auto shadow-[0_0_15px_rgba(var(--color-primary),0.05)]"
        >
          {recalculating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Recalculating...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span>Recalculate Live</span>
            </>
          )}
        </button>
      </div>

      <motion.div {...animatedProps} className="grid grid-cols-1 md:grid-cols-3 gap-6 min-w-0">
        {/* Personality Box */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between relative overflow-hidden backdrop-blur-md shadow-sm hover:border-primary/30 transition min-w-0"
        >
          <div className="space-y-4 z-10 flex-1 min-w-0">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Music Personality
            </span>
            <h3 className="font-editorial text-3xl font-bold text-text leading-tight truncate max-w-full">
              {data.personality}
            </h3>
            <p className="text-xs text-muted leading-relaxed line-clamp-2 overflow-hidden">
              Your listening timeline maps closely to this archetype. Keep exploring to evolve your profile.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 z-10 border-t border-border/20 pt-4 min-w-0">
            <User className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-xs text-muted truncate">Archived Archetype</span>
          </div>
          {/* Subtle logo vector outline behind card */}
          <div className="absolute right-[-20px] bottom-[-20px] opacity-[0.03] select-none pointer-events-none">
            <Sparkles className="w-40 h-40 text-primary" />
          </div>
        </motion.div>

        {/* Listening Minutes Box */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between backdrop-blur-md shadow-sm hover:border-primary/30 transition min-w-0"
        >
          <div className="space-y-4 flex-1 min-w-0">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Listening Time
            </span>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-editorial text-6xl font-bold text-text truncate">{data.totalMinutes}</span>
              <span className="text-xs text-muted font-semibold uppercase tracking-wider flex-shrink-0">Minutes</span>
            </div>
            <p className="text-xs text-muted leading-relaxed line-clamp-2 overflow-hidden">
              Calculated across your total playlist execution and session history events.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 border-t border-border/20 pt-4 min-w-0">
            <Clock className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-xs text-muted truncate">Favorite Time: {data.favoriteTime}</span>
          </div>
        </motion.div>

        {/* Discovery & Variety */}
        <motion.div
          {...childAnimatedProps}
          className="bg-surface/50 border border-border/80 rounded-2xl p-6 flex flex-col justify-between backdrop-blur-md shadow-sm hover:border-primary/30 transition min-w-0"
        >
          <div className="space-y-4 flex-1 min-w-0">
            <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
              Acoustic Metrics
            </span>
            <div className="space-y-2 min-w-0">
              <div className="flex items-center justify-between min-w-0">
                <span className="text-xs text-muted truncate">Discovery Score</span>
                <span className="text-sm font-semibold text-text flex-shrink-0 ml-2">{data.discoveryScore}%</span>
              </div>
              <div className="h-1.5 w-full bg-surface-elevated rounded-full overflow-hidden">
                <div className="h-full bg-primary animate-pulse" style={{ width: `${data.discoveryScore}%` }} />
              </div>
            </div>
            <p className="text-xs text-muted leading-relaxed line-clamp-2 overflow-hidden">
              High scores signify exploration of new artists, while low scores suggest deep loyalty to standard tracks.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-8 border-t border-border/20 pt-4 min-w-0">
            <Compass className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-xs text-muted truncate">Top Genre: {data.topGenres[0] || "Pop / Indie"}</span>
          </div>
        </motion.div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 min-w-0">
        {/* Sound DNA Breakdown */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-6 min-w-0 overflow-hidden">
          <div>
            <h3 className="font-editorial text-2xl text-text font-bold">Sound DNA</h3>
            <p className="text-xs text-muted line-clamp-2 overflow-hidden">Visual representation of structural song tags computed from play patterns.</p>
          </div>
          {data.insufficientHistory ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted min-w-0">
              <Sparkles className="w-8 h-8 text-primary/50 mb-3 animate-pulse flex-shrink-0" />
              <p className="text-sm font-medium truncate max-w-full">Keep listening to build your DNA</p>
            </div>
          ) : (
            <SoundDNAChart soundDNA={data.soundDNA} />
          )}
        </div>

        {/* Top Genres and Details */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 flex flex-col justify-between gap-6 min-w-0 overflow-hidden">
          <div>
            <h3 className="font-editorial text-2xl text-text font-bold">Top Genres</h3>
            <p className="text-xs text-muted line-clamp-2 overflow-hidden">The emotional frequency bands you tune into the most.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 min-w-0">
            {data.topGenres.map((genre, idx) => (
              <div key={genre} className="flex items-center justify-between p-3.5 bg-surface-elevated/40 border border-border/50 rounded-xl hover:border-primary/20 transition min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-muted flex-shrink-0">0{idx + 1}</span>
                  <span className="text-sm font-semibold text-text truncate">{genre}</span>
                </div>
                <span className="text-[10px] uppercase font-mono tracking-widest text-primary font-bold flex-shrink-0 ml-2">Aligned</span>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted border-t border-border/20 pt-4 flex justify-between gap-4 min-w-0">
            <span className="truncate">Automatic refresh daily</span>
            <span className="truncate">Based on histories</span>
          </div>
        </div>
      </div>

      {/* Top Songs */}
      <div className="space-y-4 min-w-0">
        <h3 className="font-editorial text-2xl text-text font-bold">Your Heavy Rotation</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
          {data.topSongs.map((song, idx) => (
            <button
              key={song.videoId}
              onClick={() => playSong(song as any, data.topSongs as any)}
              className="flex items-center justify-between p-4 bg-surface/40 hover:bg-surface-elevated/50 border border-border/60 rounded-xl text-left w-full cursor-pointer transition border border-transparent hover:border-primary/30 min-w-0 overflow-hidden"
            >
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <span className="text-sm font-mono text-muted w-5 flex-shrink-0">0{idx + 1}</span>
                <SongArtwork song={song} className="w-12 h-12 rounded shadow flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-bold text-text line-clamp-2 md:line-clamp-1 md:truncate overflow-hidden leading-snug max-w-full">
                    {song.title}
                  </h4>
                  <p className="text-xs text-muted truncate mt-0.5 max-w-full">
                    {formatArtists(song.artist)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4 flex-shrink-0 ml-4">
                <div className="text-right">
                  <span className="text-xs font-bold text-primary whitespace-nowrap">
                    {song.plays ? (song.plays === 1 ? "1 play" : `${song.plays} plays`) : "Recently played"}
                  </span>
                </div>
                <Play className="w-4 h-4 text-muted fill-current hover:text-primary transition flex-shrink-0" />
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Top Artists */}
      <div className="space-y-4 min-w-0">
        <h3 className="font-editorial text-2xl text-text font-bold">Top Artists</h3>
        <div className="flex overflow-x-auto pb-4 gap-4 md:grid md:grid-cols-5 md:overflow-visible md:pb-0 scrollbar-thin min-w-0">
          {data.topArtists.map((artist) => (
            <div
              key={artist.artist}
              className="p-4 bg-surface/40 border border-border/60 rounded-xl text-center flex flex-col items-center gap-3 hover:border-primary/30 transition min-w-[140px] md:min-w-0 overflow-hidden flex-shrink-0 md:flex-shrink"
            >
              {artist.thumbnail ? (
                <img src={artist.thumbnail} loading="lazy" decoding="async" alt={artist.artist} className="w-20 h-20 rounded-full object-cover shadow border border-border/40 flex-shrink-0" />
              ) : (
                <div className="w-20 h-20 rounded-full bg-surface-elevated border border-border flex items-center justify-center flex-shrink-0">
                  <Music className="w-8 h-8 text-accent opacity-50" />
                </div>
              )}
              <div className="min-w-0 w-full flex-1">
                <h4 className="text-sm font-bold text-text truncate leading-tight w-full px-2">
                  {formatArtists(artist.artist)}
                </h4>
                <p className="text-xs text-muted mt-1 font-semibold truncate">
                  {artist.plays ? (artist.plays === 1 ? "1 play" : `${artist.plays} plays`) : "Recently played"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

