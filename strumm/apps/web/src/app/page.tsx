"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import SmartFlow from "web/components/SmartFlow";
import { apiUrl, cleanText } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";

import { Search, Play } from "lucide-react";
import { Song } from "@strumm/types";

export default function HomePage() {
  const { token } = useAuthStore();
  const { playSong } = usePlayerStore();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Song[]>([]);
  const [trending, setTrending] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Perform search queries on typing
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const response = await fetch(apiUrl(`/search?q=${encodeURIComponent(cleanText(searchQuery, 120))}`));
        const json = await response.json();
        if (json.success && json.data) {
          setSearchResults(json.data.results.songs || []);
          setTrending(json.data.trending || []);
        }
      } catch (e) {
        console.warn("Search API offline.");
      } finally {
        setSearchLoading(false);
      }
    }, 400);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  return (
    <div className="space-y-10">
      {/* Editorial Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Welcome Home
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Where your music lives.
        </h2>
      </div>

      {/* Global Search box */}
      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute left-4 top-4 w-4.5 h-4.5 text-muted" />
          <input
            type="text"
            placeholder="Search song titles, artists, genres, mood flow..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface/50 border border-border/80 rounded-xl pl-11 pr-4 py-3.5 text-base text-text focus:outline-none focus:border-primary/50 transition shadow-sm"
          />
        </div>

        {/* Real-time search matches list */}
        {searchResults.length > 0 && (
          <div className="bg-surface/90 border border-border rounded-xl p-4 space-y-3">
            <h3 className="text-xs uppercase tracking-wider text-primary font-semibold">Catalog Matches</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {searchResults.map((song) => (
                <button
                  key={song.videoId}
                  onClick={() => {
                    playSong(song, searchResults);
                  }}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-elevated text-left w-full cursor-pointer transition border border-transparent hover:border-border/60"
                >
                  <SongArtwork song={song} className="w-10 h-10 rounded shadow flex-shrink-0" />
                  <div className="min-w-0 flex-grow">
                    <div className="text-sm font-semibold text-text truncate leading-snug">{song.title}</div>
                    <div className="text-xs text-muted truncate">{song.artist}</div>
                  </div>
                  <Play className="w-3.5 h-3.5 text-muted fill-current hover:text-primary transition" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-xl">
        <SmartFlow />
      </div>
    </div>
  );
}
