"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import { apiFetch } from "web/lib/api-client";
import Link from "next/link";
import { BarChart3, Clock, Music, Headphones, TrendingUp, Loader2 } from "lucide-react";

interface ListeningStats {
  period_days: number;
  total_minutes: number;
  total_hours: number;
  avg_daily_minutes: number;
  daily_breakdown: Array<{
    date: string;
    minutesListened: number;
    hoursListened: number;
    songCount: number;
  }>;
}

interface GenreStats {
  top_genres: Array<{
    genre: string;
    plays: number;
    minutes: number;
  }>;
  unique_genres: number;
}

interface Song {
  songId: string;
  title: string;
  artist: string;
  plays: number;
  totalMinutes: number;
  coverUrl?: string;
}

interface Artist {
  artist: string;
  plays: number;
  minutes: number;
}

interface DiscoveryStats {
  new_songs: number;
  repeat_plays: number;
  discovery_rate_percent: number;
  total_plays: number;
}

interface DashboardData {
  listening_time: ListeningStats;
  genres: GenreStats;
  top_songs: Song[];
  top_artists: Artist[];
  discovery: DiscoveryStats;
  period_days: number;
}

export default function StatsPage() {
  const { token, user } = useAuthStore();
  const { show: showNotification } = useNotificationStore();
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!user) return;
    fetchStats();
  }, [token, period]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await apiFetch<DashboardData>(`/stats/dashboard?days=${period}`, { token });
      setData(data);
    } catch (error) {
      showNotification("Failed to load listening statistics", "error");
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-6 gap-4">
        <BarChart3 className="w-12 h-12 text-primary opacity-50" />
        <h1 className="font-editorial text-2xl text-text font-bold">Statistics Locked</h1>
        <p className="text-sm text-muted">Please log in to view your listening statistics.</p>
        <Link href="/login" className="text-primary hover:underline text-sm font-semibold">
          Go to Login
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-10 max-w-6xl pb-10 soft-enter">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Analytics
        </span>
        <h1 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Listening Statistics
        </h1>
        <p className="text-sm text-muted mt-2">Discover your music taste and listening habits.</p>
      </div>

      {/* Period Selector */}
      <div className="flex gap-2 flex-wrap">
        {[7, 30, 90, 365].map((days) => (
          <button
            key={days}
            onClick={() => setPeriod(days)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
              period === days
                ? "bg-primary text-background border border-primary"
                : "bg-surface-elevated/40 text-muted hover:text-text border border-border/60 hover:border-border"
            }`}
          >
            {days === 7 ? "Week" : days === 30 ? "Month" : days === 90 ? "Quarter" : "Year"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="text-xs uppercase tracking-widest">Loading statistics...</span>
        </div>
      ) : data ? (
        <div className="space-y-8">
          {/* Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-surface border border-border/60 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Clock className="w-4 h-4 text-primary" />
                <span className="uppercase tracking-wider font-semibold">Total Time</span>
              </div>
              <div className="text-3xl font-editorial font-bold text-text">{Math.round(data.listening_time.total_hours)} hrs</div>
              <div className="text-xs text-muted">{data.listening_time.total_minutes.toLocaleString()} minutes</div>
            </div>
            <div className="bg-surface border border-border/60 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <TrendingUp className="w-4 h-4 text-accent" />
                <span className="uppercase tracking-wider font-semibold">Daily Avg</span>
              </div>
              <div className="text-3xl font-editorial font-bold text-text">{data.listening_time.avg_daily_minutes} min</div>
              <div className="text-xs text-muted">per day</div>
            </div>
            <div className="bg-surface border border-border/60 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Music className="w-4 h-4 text-primary" />
                <span className="uppercase tracking-wider font-semibold">Songs Played</span>
              </div>
              <div className="text-3xl font-editorial font-bold text-text">{data.discovery.total_plays.toLocaleString()}</div>
              <div className="text-xs text-muted">{data.discovery.new_songs} new</div>
            </div>
            <div className="bg-surface border border-border/60 rounded-xl p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Headphones className="w-4 h-4 text-accent" />
                <span className="uppercase tracking-wider font-semibold">Discovery</span>
              </div>
              <div className="text-3xl font-editorial font-bold text-text">{data.discovery.discovery_rate_percent}%</div>
              <div className="text-xs text-muted">new songs</div>
            </div>
          </div>

          {/* Top Genres */}
          {data.genres.top_genres.length > 0 && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
              <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">Top Genres</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.genres.top_genres.slice(0, 6).map((genre, idx) => (
                  <div key={genre.genre} className="bg-surface-elevated/40 border border-border/40 rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-muted">#{idx + 1}</span>
                      <span className="text-[10px] font-semibold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
                        {genre.plays} plays
                      </span>
                    </div>
                    <div className="font-editorial text-lg font-bold text-text truncate">{genre.genre}</div>
                    <div className="text-xs text-muted">{genre.minutes} minutes</div>
                    <div className="w-full bg-border/30 rounded-full h-1.5">
                      <div
                        className="bg-primary rounded-full h-1.5"
                        style={{
                          width: `${(genre.minutes / Math.max(...data.genres.top_genres.map((g) => g.minutes))) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Songs */}
          {data.top_songs.length > 0 && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
              <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">Top Songs</h2>
              <div className="space-y-3">
                {data.top_songs.map((song, idx) => (
                  <div key={song.songId} className="flex items-center gap-4 bg-surface-elevated/20 border border-border/30 rounded-xl p-3">
                    <div className="text-lg font-bold text-primary w-8 text-center font-mono">{idx + 1}</div>
                    {song.coverUrl && (
                      <img src={song.coverUrl} alt={song.title} loading="lazy" decoding="async" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-text truncate">{song.title}</div>
                      <div className="text-xs text-muted truncate">{song.artist}</div>
                    </div>
                    <div className="text-right text-xs flex-shrink-0">
                      <div className="font-bold text-text">{song.plays} plays</div>
                      <div className="text-muted">{song.totalMinutes} min</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Artists */}
          {data.top_artists.length > 0 && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
              <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">Top Artists</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.top_artists.map((artist, idx) => (
                  <div key={artist.artist} className="bg-surface-elevated/40 border border-border/40 rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold text-primary font-mono">#{idx + 1}</span>
                      <span className="text-[10px] font-semibold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded">
                        {artist.plays} plays
                      </span>
                    </div>
                    <div className="font-editorial text-lg font-bold text-text truncate">{artist.artist}</div>
                    <div className="text-xs text-muted">{artist.minutes} minutes</div>
                    <div className="w-full bg-border/30 rounded-full h-1.5">
                      <div
                        className="bg-primary rounded-full h-1.5"
                        style={{
                          width: `${(artist.minutes / Math.max(...data.top_artists.map((a) => a.minutes))) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-20 border border-dashed border-border/60 rounded-xl bg-surface/20">
          <BarChart3 className="w-8 h-8 text-muted mx-auto mb-2" />
          <p className="text-sm text-text font-semibold">No data available</p>
          <p className="text-xs text-muted mt-1">Start listening to populate your statistics.</p>
        </div>
      )}
    </div>
  );
}
