"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import Link from "next/link";

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
  const { token } = useAuthStore();
  const { show: showNotification } = useNotificationStore();
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchStats();
  }, [token, period]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/stats/dashboard?days=${period}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!res.ok) throw new Error("Failed to fetch stats");

      const json = await res.json();
      if (json.success) {
        setData(json.data);
      }
    } catch (error) {
      showNotification("Failed to load listening statistics", "error");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="pt-20 pb-8 text-center">
        <p className="text-muted mb-4">Please log in to view your statistics</p>
        <Link href="/login" className="text-primary hover:underline">
          Go to Login
        </Link>
      </div>
    );
  }

  return (
    <div className="pt-20 pb-8 px-4 sm:px-6 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">Your Listening Stats</h1>
        <p className="text-muted">Discover your music taste and habits</p>
      </div>

      {/* Period Selector */}
      <div className="flex gap-2 mb-8 flex-wrap">
        {[7, 30, 90, 365].map((days) => (
          <button
            key={days}
            onClick={() => setPeriod(days)}
            className={`px-4 py-2 rounded-lg transition ${
              period === days
                ? "bg-primary text-white"
                : "bg-secondary text-text hover:bg-secondary/80"
            }`}
          >
            {days === 7
              ? "Week"
              : days === 30
                ? "Month"
                : days === 90
                  ? "Quarter"
                  : "Year"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </div>
      ) : data ? (
        <div className="space-y-8">
          {/* Overview Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <OverviewCard
              label="Total Listening Time"
              value={`${Math.round(data.listening_time.total_hours)} hrs`}
              subtext={`${data.listening_time.total_minutes.toLocaleString()} minutes`}
            />
            <OverviewCard
              label="Daily Average"
              value={`${data.listening_time.avg_daily_minutes} min`}
              subtext="per day"
            />
            <OverviewCard
              label="Songs Played"
              value={data.discovery.total_plays.toLocaleString()}
              subtext={`${data.discovery.new_songs} new`}
            />
            <OverviewCard
              label="Discovery Rate"
              value={`${data.discovery.discovery_rate_percent}%`}
              subtext="new songs"
            />
          </div>

          {/* Top Genres */}
          {data.genres.top_genres.length > 0 && (
            <div className="bg-secondary/50 rounded-lg p-6 border border-border">
              <h2 className="text-xl font-semibold mb-4">Top Genres</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.genres.top_genres.slice(0, 6).map((genre, idx) => (
                  <div key={genre.genre} className="bg-background/60 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{idx + 1}.</span>
                      <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded">
                        {genre.plays} plays
                      </span>
                    </div>
                    <div className="font-semibold text-lg truncate mb-1">
                      {genre.genre}
                    </div>
                    <div className="text-sm text-muted">
                      {genre.minutes} minutes
                    </div>
                    <div className="mt-2 w-full bg-background rounded-full h-2">
                      <div
                        className="bg-primary rounded-full h-2"
                        style={{
                          width: `${
                            (genre.minutes /
                              Math.max(
                                ...data.genres.top_genres.map((g) => g.minutes)
                              )) *
                            100
                          }%`,
                        }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Songs */}
          {data.top_songs.length > 0 && (
            <div className="bg-secondary/50 rounded-lg p-6 border border-border">
              <h2 className="text-xl font-semibold mb-4">Top Songs</h2>
              <div className="space-y-3">
                {data.top_songs.map((song, idx) => (
                  <div key={song.songId} className="flex items-center gap-4 bg-background/60 rounded-lg p-4">
                    <div className="text-lg font-bold text-primary w-8 text-center">
                      {idx + 1}
                    </div>
                    {song.coverUrl && (
                      <img
                        src={song.coverUrl}
                        alt={song.title}
                        className="w-12 h-12 rounded object-cover"
                      />
                    )}
                    <div className="flex-1">
                      <div className="font-semibold truncate">{song.title}</div>
                      <div className="text-sm text-muted truncate">
                        {song.artist}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-semibold">{song.plays} plays</div>
                      <div className="text-muted">{song.totalMinutes} min</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Artists */}
          {data.top_artists.length > 0 && (
            <div className="bg-secondary/50 rounded-lg p-6 border border-border">
              <h2 className="text-xl font-semibold mb-4">Top Artists</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.top_artists.map((artist, idx) => (
                  <div key={artist.artist} className="bg-background/60 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-lg font-bold text-primary">
                        #{idx + 1}
                      </span>
                      <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded">
                        {artist.plays} plays
                      </span>
                    </div>
                    <div className="font-semibold text-lg truncate mb-1">
                      {artist.artist}
                    </div>
                    <div className="text-sm text-muted">
                      {artist.minutes} minutes
                    </div>
                    <div className="mt-2 w-full bg-background rounded-full h-2">
                      <div
                        className="bg-primary rounded-full h-2"
                        style={{
                          width: `${
                            (artist.minutes /
                              Math.max(
                                ...data.top_artists.map((a) => a.minutes)
                              )) *
                            100
                          }%`,
                        }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-12 text-muted">
          No listening data available for this period
        </div>
      )}
    </div>
  );
}

function OverviewCard({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string;
  subtext: string;
}) {
  return (
    <div className="bg-secondary/50 rounded-lg p-6 border border-border">
      <div className="text-sm text-muted mb-2">{label}</div>
      <div className="text-3xl font-bold mb-1">{value}</div>
      <div className="text-xs text-muted">{subtext}</div>
    </div>
  );
}
