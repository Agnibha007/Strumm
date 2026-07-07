"use client";

import { useEffect, useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import Link from "next/link";
import { Play, Heart, ListMusic } from "lucide-react";
import { Song } from "@strumm/types";

export default function LikedSongsSection({ token }: { token: string | null }) {
  const { playSong } = usePlayerStore();
  const [likedSongs, setLikedSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const resp = await fetch(apiUrl("/liked?limit=10"), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await resp.json();
        if (json.success && json.data) {
          setLikedSongs(json.data.map((item: any) => item.song) || []);
        }
      } catch (e) {
        console.warn("Failed to load liked songs.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [token]);

  if (loading) {
    return <LikedSongsSkeleton />;
  }

  return (
    <section aria-label="Your liked songs">
      <div className="space-y-4">
        <header className="flex items-center justify-between border-b border-border/20 pb-2">
          <h2 className="font-editorial text-2xl text-text font-bold flex items-center gap-2">
            <Heart className="w-5 h-5 text-red-500 fill-current" />
            Your Liked Songs
          </h2>
          <Link href="/library" className="text-[10px] text-muted uppercase tracking-wider font-semibold hover:text-text transition">View All</Link>
        </header>

        {likedSongs.length === 0 ? (
          <div className="text-center py-10 bg-surface/30 border border-border/40 rounded-xl">
            <p className="text-xs text-muted">You haven&apos;t liked any songs yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {likedSongs.map((song, idx) => (
              <article key={`liked-${song.videoId}-${idx}`}>
                <button
                  onClick={() => playSong(song, likedSongs)}
                  className="p-2.5 bg-transparent hover:bg-surface/60 rounded-lg transition flex items-center gap-3 text-left w-full cursor-pointer group"
                >
                  <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 relative">
                    <SongArtwork song={song} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Play className="w-4 h-4 text-white fill-current" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-grow flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-editorial text-sm font-bold text-text truncate group-hover:text-primary transition">
                        {song.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-0.5">
                        {song.artist}
                      </div>
                    </div>
                    <ListMusic className="w-4 h-4 text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </div>
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function LikedSongsSkeleton() {
  return (
    <section aria-label="Your liked songs">
      <div className="space-y-4 animate-pulse">
        <header className="flex items-center justify-between border-b border-border/20 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-red-500/30" />
            <div className="h-5 w-32 bg-border/40 rounded" />
          </div>
          <div className="h-3 w-12 bg-border/40 rounded" />
        </header>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg">
              <div className="w-10 h-10 rounded bg-border/40 flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 bg-border/40 rounded" />
                <div className="h-2 w-1/3 bg-border/30 rounded" />
              </div>
              <div className="w-4 h-4 rounded bg-border/20" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
