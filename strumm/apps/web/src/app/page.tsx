"use client";

import { Suspense, useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { cleanText } from "web/lib/api";
import { searchYouTube } from "web/lib/search";
import SongArtwork from "web/components/SongArtwork";

import { Search, Play, Sparkles } from "lucide-react";
import Link from "next/link";
import { Song } from "@strumm/types";

import LoginPage from "./login/page";
import DiscoverySection, { DiscoverySkeleton } from "web/components/DiscoverySection";
import LikedSongsSection, { LikedSongsSkeleton } from "web/components/LikedSongsSection";

export default function HomePage() {
  const { user, token } = useAuthStore();
  const { playSong } = usePlayerStore();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Song[]>([]);

  // Perform search queries on typing (directly from browser via Invidious API)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      try {
        const results = await searchYouTube({
          query: cleanText(searchQuery, 120),
          type: "video"
        });
        setSearchResults(results.songs || []);
      } catch (e) {
        console.warn("Search API offline.");
      }
    }, 400);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="space-y-10 max-w-7xl pb-10 soft-enter">
      {/* Editorial Header — renders immediately on first paint */}
      <header>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Welcome Home
        </span>
        <h1 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Where your music lives.
        </h1>
      </header>

      {/* Global Search — renders immediately */}
      <section aria-label="Search music">
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-4 top-4 w-4.5 h-4.5 text-muted" aria-hidden="true" />
            <label htmlFor="home-search" className="sr-only">Search songs, artists, and podcasts</label>
            <input
              id="home-search"
              type="text"
              placeholder="Search song titles, artists, genres, mood flow..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-surface/50 border border-border/80 rounded-xl pl-11 pr-4 py-3.5 text-base text-text focus:outline-none focus:border-primary/50 transition shadow-sm"
            />
          </div>

          {/* Real-time search matches list */}
          {searchResults.length > 0 && (
            <section aria-label="Search results">
              <div className="bg-surface/90 border border-border rounded-xl p-4 space-y-3">
                <h2 className="text-xs uppercase tracking-wider text-primary font-semibold">Catalog Matches</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {searchResults.map((song) => (
                    <article key={song.videoId}>
                      <button
                        onClick={() => {
                          playSong(song, searchResults);
                        }}
                        aria-label={`Play ${song.title} by ${song.artist}`}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-elevated text-left w-full cursor-pointer transition border border-transparent hover:border-border/60"
                      >
                        <SongArtwork song={song} className="w-10 h-10 rounded shadow flex-shrink-0" />
                        <div className="min-w-0 flex-grow">
                          <div className="text-sm font-semibold text-text truncate leading-snug">{song.title}</div>
                          <div className="text-xs text-muted truncate">{song.artist}</div>
                        </div>
                        <Play className="w-3.5 h-3.5 text-muted fill-current hover:text-primary transition" />
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </section>

      {/* Content sections stream independently via Suspense boundaries */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-4">
          <Suspense fallback={<DiscoverySkeleton />}>
            <DiscoverySection token={token} />
          </Suspense>
        </div>
        <div className="space-y-4">
          <Suspense fallback={<LikedSongsSkeleton />}>
            <LikedSongsSection token={token} />
          </Suspense>
          {/* Strumm Flow Promo — renders immediately, outside Suspense */}
          <article className="bg-surface/30 border border-border/40 rounded-2xl p-6 flex flex-col items-center text-center shadow-sm backdrop-blur-md space-y-4">
            <div className="p-3.5 bg-primary/10 rounded-full text-primary">
              <Sparkles className="w-6 h-6 animate-pulse" />
            </div>
            <div className="space-y-1">
              <h3 className="font-editorial text-lg font-bold text-text">Strumm Flow Assistant</h3>
              <p className="text-xs text-muted max-w-sm leading-relaxed">
                Meet your personal music curator. Strumm Flow can search, recommend, and build customized smart playlists dynamically in your library.
              </p>
            </div>
            <Link
              href="/flow"
              className="px-5 py-2.5 bg-text hover:bg-white text-background font-editorial text-xs font-semibold rounded-xl hover:opacity-90 transition shadow-md flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" /> Start Curation Flow
            </Link>
          </article>
        </div>
      </div>
    </div>
  );
}

