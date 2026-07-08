"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Clock, Heart, Play, Trash2, Plus, Check } from "lucide-react";
import { Song } from "@strumm/types";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";

export default function LibraryPage() {
  const { user, token } = useAuthStore();
  const { playSong, addToQueue, queue } = usePlayerStore();
  const [likedSongs, setLikedSongs] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
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
      }
    };
    const fetchHistory = async () => {
      try {
        const response = await fetch(apiUrl("/history?limit=20"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const json = await response.json();
        if (json.success && json.data) {
          setHistory(json.data);
        }
      } catch (e) {
        console.warn("Offline fallback. Unable to load history.");
      }
    };
    
    Promise.all([fetchLikes(), fetchHistory()]).finally(() => setLoading(false));
  }, [token]);

  const formatListeningTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins} mins`;
    const hrs = (mins / 60).toFixed(1);
    return `${hrs} hours`;
  };

  const handlePlayLiked = (song: Song) => {
    const songList = likedSongs.map((l) => l.song);
    playSong(song, songList);
  };

  const handleDeleteHistory = async () => {
    if (!confirm("Are you sure you want to permanently delete your listening history?")) return;
    try {
      const response = await fetch(apiUrl("/history"), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setHistory([]);
      }
    } catch (e) {
      console.error("Failed to delete history");
    }
  };

  if (!user) return null;

  const SkeletonLine = ({ wide = false }: { wide?: boolean }) => (
    <div className={`h-3 rounded bg-border/50 animate-pulse ${wide ? "w-36" : "w-20"}`} />
  );

  return (
    <div className="space-y-10 soft-enter">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Your Collection
        </span>
        <h1 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Music Library
        </h1>
      </div>

      {/* Stats Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Playback time stats */}
        <div className="bg-surface border border-border/60 rounded-xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-20 h-20 bg-primary/5 rounded-full blur-2xl" />
          <h2 className="font-editorial text-lg text-text border-b border-border/20 pb-2 mb-4">
            Listening Minutes
          </h2>
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
          <h2 className="font-editorial text-lg text-text border-b border-border/20 pb-2 mb-4">
            Liked Records
          </h2>
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

      {/* Liked Songs + Top Artists row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Liked songs list */}
        <div className="lg:col-span-8 bg-surface border border-border/60 rounded-xl p-6 space-y-4">
          <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
            Liked Songs
          </h2>

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
                  <div
                    key={s.videoId}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-elevated text-left w-full transition border border-transparent hover:border-border/40 group"
                  >
                    <button
                      onClick={() => handlePlayLiked(s)}
                      className="flex items-center gap-3 min-w-0 flex-grow text-left cursor-pointer"
                    >
                      <SongArtwork song={s} className="w-9 h-9 rounded shadow flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate leading-tight">{s.title}</div>
                        <div className="text-xs text-muted truncate mt-0.5">{s.artist}</div>
                      </div>
                    </button>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                      <button
                        onClick={() => handlePlayLiked(s)}
                        className="p-1.5 hover:bg-surface text-primary rounded-lg transition"
                        title="Play"
                      >
                        <Play className="w-4 h-4 fill-current" />
                      </button>
                      <button
                        onClick={() => addToQueue(s)}
                        className="p-1.5 hover:bg-surface text-muted hover:text-text rounded-lg transition"
                        title="Add to queue"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Top Artists */}
        <div className="lg:col-span-4 bg-surface border border-border/60 rounded-xl p-6 space-y-4">
          <h2 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
            Top Artists
          </h2>

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

      {/* Listening History (full width below) */}
      <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-border/20 pb-2">
          <h2 className="font-editorial text-xl text-text">
            Listening History
          </h2>
          {history.length > 0 && (
            <button 
              onClick={handleDeleteHistory}
              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-400 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear History
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, idx) => (
              <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border border-border/20 bg-background/20">
                <div className="w-9 h-9 rounded bg-border/50 animate-pulse" />
                <div className="space-y-2">
                  <div className="h-3 w-44 rounded bg-border/50 animate-pulse" />
                  <div className="h-2.5 w-28 rounded bg-border/40 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-xs text-muted italic py-6">Your listening history is empty.</p>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 scrollbar-none">
            {history.map((item, idx) => {
              const s = item.song;
              return (
                <div
                  key={`${s.videoId}-${idx}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-elevated text-left w-full transition border border-transparent hover:border-border/40 group"
                >
                  <button
                    onClick={() => playSong(s)}
                    className="flex items-center gap-3 min-w-0 flex-grow text-left cursor-pointer"
                  >
                    <SongArtwork song={s} className="w-9 h-9 rounded shadow flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text truncate leading-tight">{s.title}</div>
                      <div className="text-xs text-muted truncate mt-0.5">{s.artist}</div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    <span className="text-[10px] text-muted mr-1">
                      {new Date(item.playedAt).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                      <button
                        onClick={() => playSong(s)}
                        className="p-1.5 hover:bg-surface text-primary rounded-lg transition"
                        title="Play"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                      </button>
                      {(() => {
                        const isInQueue = queue.some((item) => item.videoId === s.videoId);
                        return (
                          <button
                            onClick={() => !isInQueue && addToQueue(s)}
                            className={`p-1.5 rounded-lg transition ${isInQueue ? "text-muted/40 cursor-default" : "hover:bg-surface text-muted hover:text-text cursor-pointer"}`}
                            title={isInQueue ? "Added to queue" : "Add to queue"}
                          >
                            {isInQueue ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
