"use client";

import { useEffect, useState } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import { Play, Sparkles, Loader2, Radio } from "lucide-react";
import { Song } from "@strumm/types";

export default function DiscoverySection({ token }: { token: string | null }) {
  const { playSong, isRadio, isRadioLoading, triggerRadio } = usePlayerStore();
  const [recommendations, setRecommendations] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const resp = await fetch(apiUrl("/explore-mix"), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await resp.json();
        if (json.success && json.data) {
          setRecommendations(json.data.songs || []);
        }
      } catch (e) {
        console.warn("Failed to load recommendations.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [token]);

  if (loading) {
    return <DiscoverySkeleton />;
  }

  return (
    <section aria-label="AI-powered music recommendations">
      <div className="space-y-4">
        <header className="flex items-center justify-between border-b border-border/20 pb-2">
          <h2 className="font-editorial text-2xl text-text font-bold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Discovery Mix
          </h2>
          <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">Adaptive</span>
        </header>

        {recommendations.length === 0 ? (
          <div className="text-center py-10 bg-surface/30 border border-border/40 rounded-xl">
            <p className="text-xs text-muted">No recommendations available yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {recommendations.map((song, idx) => (
              <article
                key={`rec-${song.videoId}-${idx}`}
                className="p-3 bg-surface/40 border border-border/40 hover:bg-surface hover:border-border/80 rounded-xl transition group"
              >
                <div className="flex items-center gap-3 text-left w-full cursor-pointer">
                  <button
                    onClick={() => playSong(song, recommendations)}
                    className="flex items-center gap-3 flex-1 min-w-0"
                  >
                    <figure className="w-12 h-12 rounded overflow-hidden flex-shrink-0 relative m-0">
                      <SongArtwork song={song} className="w-full h-full object-cover" />
                      <figcaption className="sr-only">{song.title} by {song.artist}</figcaption>
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Play className="w-4 h-4 text-white fill-current" />
                      </div>
                    </figure>
                    <div className="min-w-0 flex-grow">
                      <div className="font-editorial text-sm font-bold text-text truncate group-hover:text-primary transition">
                        {song.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-0.5">
                        {song.artist}
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={() => triggerRadio(song.videoId)}
                    disabled={isRadioLoading}
                    className={`p-2 rounded-lg transition flex-shrink-0 self-center ${isRadioLoading ? "animate-pulse" : isRadio ? "text-primary text-glow" : "text-muted hover:text-primary opacity-0 group-hover:opacity-100"}`}
                    title={isRadioLoading ? "Loading radio..." : isRadio ? "Radio active" : "Start Radio from this song"}
                  >
                    {isRadioLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function DiscoverySkeleton() {
  return (
    <section aria-label="AI-powered music recommendations">
      <div className="space-y-4 animate-pulse">
        <header className="flex items-center justify-between border-b border-border/20 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-primary/30" />
            <div className="h-5 w-28 bg-border/40 rounded" />
          </div>
          <div className="h-3 w-16 bg-border/40 rounded" />
        </header>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-3 rounded-xl bg-surface/30 border border-border/40">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded bg-border/40 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-3/4 bg-border/40 rounded" />
                  <div className="h-2 w-1/2 bg-border/30 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
