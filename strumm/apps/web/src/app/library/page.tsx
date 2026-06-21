"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Clock, Heart, Play, User as UserIcon } from "lucide-react";
import { Song } from "@strumm/types";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";

export default function LibraryPage() {
  const { user, token } = useAuthStore();
  const { playSong } = usePlayerStore();
  const [likedSongs, setLikedSongs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLikes = async () => {
      try {
        const response = await fetch(apiUrl("/liked"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const json = await response.json();
        if (json.success && json.data) {
          setLikedSongs(json.data);
        }
      } catch (e) {
        console.warn("Offline fallback. Unable to load liked songs.");
      } finally {
        setLoading(false);
      }
    };
    fetchLikes();
  }, [token]);

  const formatListeningTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins} mins`;
    const hrs = (mins / 60).toFixed(1);
    return `${hrs} hours`;
  };

  const handlePlayLiked = (song: Song) => {
    // Extract standard song shapes from liked models
    const songList = likedSongs.map((l) => l.song);
    playSong(song, songList);
  };

  if (!user) return null;

  const SkeletonLine = ({ wide = false }: { wide?: boolean }) => (
    <div className={`h-3 rounded bg-border/50 animate-pulse ${wide ? "w-36" : "w-20"}`} />
  );

  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Your Collection
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Music Library
        </h2>
      </div>

      {/* Stats Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Playback time stats */}
        <div className="bg-surface border border-border/60 rounded-xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-20 h-20 bg-primary/5 rounded-full blur-2xl" />
          <h3 className="font-editorial text-lg text-text border-b border-border/20 pb-2 mb-4">
            Listening Minutes
          </h3>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded border border-primary/20">
              <Clock className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-xs text-muted leading-none">Lifetime Stats</div>
              {loading ? <SkeletonLine wide /> : (
                <div className="text-xl font-bold text-text mt-1">
                  {formatListeningTime(user.statistics?.totalListeningTime || 0)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Liked count stats */}
        <div className="bg-surface border border-border/60 rounded-xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-20 h-20 bg-accent/5 rounded-full blur-2xl" />
          <h3 className="font-editorial text-lg text-text border-b border-border/20 pb-2 mb-4">
            Liked Records
          </h3>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded border border-accent/20">
              <Heart className="w-5 h-5 text-accent fill-accent" />
            </div>
            <div>
              <div className="text-xs text-muted leading-none">Total Likes</div>
              {loading ? <SkeletonLine /> : (
                <div className="text-xl font-bold text-text mt-1">
                  {likedSongs.length} songs
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Liked songs list */}
        <div className="lg:col-span-8 bg-surface border border-border/60 rounded-xl p-6 space-y-4">
          <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
            Liked Songs
          </h3>

          {loading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 rounded-lg border border-border/20 bg-background/20">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded bg-border/50 animate-pulse" />
                    <div className="space-y-2">
                      <div className="h-3 w-44 rounded bg-border/50 animate-pulse" />
                      <div className="h-2.5 w-28 rounded bg-border/40 animate-pulse" />
                    </div>
                  </div>
                  <div className="w-4 h-4 rounded bg-border/40 animate-pulse" />
                </div>
              ))}
            </div>
          ) : likedSongs.length === 0 ? (
            <p className="text-xs text-muted italic py-6">Your Liked Songs list is empty. Explore and heart tracks.</p>
          ) : (
            <div className="space-y-2">
              {likedSongs.map((item) => {
                const s = item.song;
                return (
                  <button
                    key={s.videoId}
                    onClick={() => handlePlayLiked(s)}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-elevated text-left w-full cursor-pointer transition border border-transparent hover:border-border/40"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <SongArtwork song={s} className="w-9 h-9 rounded shadow flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate leading-tight">{s.title}</div>
                        <div className="text-xs text-muted truncate mt-0.5">{s.artist}</div>
                      </div>
                    </div>
                    <Play className="w-4 h-4 text-muted fill-current hover:text-primary transition flex-shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Top Artists widgets */}
        <div className="lg:col-span-4 bg-surface border border-border/60 rounded-xl p-6 space-y-4">
          <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
            Top Artists
          </h3>

          {loading ? (
            <div className="space-y-3 py-1">
              {Array.from({ length: 5 }).map((_, idx) => (
                <div key={idx} className="flex justify-between items-center py-1">
                  <div className="h-3 w-28 rounded bg-border/50 animate-pulse" />
                  <div className="h-3 w-12 rounded bg-border/40 animate-pulse" />
                </div>
              ))}
            </div>
          ) : user.statistics?.topArtists?.length === 0 ? (
            <p className="text-xs text-muted italic py-4">Listen to tracks to log top artists.</p>
          ) : (
            <div className="space-y-3">
              {user.statistics?.topArtists?.map((art, idx) => (
                <div key={idx} className="flex justify-between items-center text-sm py-1 border-b border-border/10 last:border-0 pb-1">
                  <span className="font-medium text-text">{art.name}</span>
                  <span className="text-xs text-muted">{art.playCount} plays</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
