"use client";

import { Suspense, useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { cleanText } from "web/lib/api";
import { searchYouTube } from "web/lib/search";
import SongArtwork from "web/components/SongArtwork";
import { ARTWORK_QUALITY_LOW } from "web/lib/media";

import { Search, Play } from "lucide-react";
import { Song } from "@strumm/types";

import LoginPage from "./login/page";
import DiscoverySection, { DiscoverySkeleton } from "web/components/DiscoverySection";
import LikedSongsSection, { LikedSongsSkeleton } from "web/components/LikedSongsSection";
import RecentlyPlayedPlaylist from "web/components/RecentlyPlayedPlaylist";

export default function HomePage() {
  const { user, token } = useAuthStore();
  const { playSongAndContinue } = usePlayerStore();
  
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
    <div className="space-y-10 max-w-[1400px] pb-10 soft-enter">
      {/* Editorial Header — bold reform */}
      <header className="reform-panel relative overflow-hidden p-6 sm:p-8 md:p-10">
        <div className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -left-10 -bottom-16 h-48 w-48 rounded-full bg-accent/15 blur-3xl pointer-events-none" />
        <span className="reform-chip mb-4">Welcome Home</span>
        <h1 className="reform-heading-xl text-text mt-2 max-w-4xl">
          Where your <span className="text-primary text-glow">music</span> lives.
        </h1>
        <p className="mt-4 text-sm sm:text-base text-muted max-w-2xl font-medium">
          Discover, queue, and play with a bolder, louder Strumm experience.
        </p>
      </header>

      {/* Global Search — renders immediately */}
      <section aria-label="Search music">
        <div className="space-y-4">
          <div className="relative group">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-primary" aria-hidden="true" />
            <label htmlFor="home-search" className="sr-only">Search songs, artists, and podcasts</label>
            <input
              id="home-search"
              type="text"
              placeholder="Search songs, artists, podcasts, moods..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="reform-input w-full pl-14 pr-5 py-4 sm:py-5 text-base sm:text-lg font-semibold placeholder:text-muted/70 shadow-[0_10px_30px_-20px_rgba(0,0,0,0.8)]"
            />
          </div>

          {/* Real-time search matches list */}
          {searchResults.length > 0 && (
            <section aria-label="Search results">
              <div className="reform-panel p-4 sm:p-5 space-y-4">
                <h2 className="reform-chip w-fit">Catalog Matches</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {searchResults.map((song) => {
                    // Decode provider-supplied entities for display. The player
                    // store does this on the way into the queue, so without it
                    // the same song showed as `Tom &amp; Jerry` here and
                    // `Tom & Jerry` in the player.
                    const title = cleanText(song.title || "", 200);
                    const artist = cleanText(song.artist || "", 120);
                    return (
                    <article key={song.videoId}>
                      <button
                        onClick={() => {
                          // Only the picked result — the rest of the result list
                          // must not silently become the up-next queue.
                          playSongAndContinue(song);
                        }}
                        aria-label={`Play ${title} by ${artist}`}
                        className="reform-card group flex items-center gap-3 p-3 text-left w-full cursor-pointer transition"
                      >
                        <SongArtwork song={song} className="w-12 h-12 rounded-lg shadow flex-shrink-0 border border-border/60" quality={ARTWORK_QUALITY_LOW} />
                        <div className="min-w-0 flex-grow">
                          <div className="text-sm sm:text-base font-extrabold text-text truncate leading-snug group-hover:text-primary transition-colors">{title}</div>
                          <div className="text-xs sm:text-sm text-muted truncate font-medium">{artist}</div>
                        </div>
                        <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/15 border border-primary/30 text-primary group-hover:bg-primary group-hover:text-background transition">
                          <Play className="w-4 h-4 fill-current ml-0.5" />
                        </span>
                      </button>
                    </article>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </div>
      </section>

      {/* Content sections stream independently via Suspense boundaries */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-4">
          {user.settings?.showDiscoveryMix !== false && (
            <Suspense fallback={<DiscoverySkeleton />}>
              <DiscoverySection token={token} />
            </Suspense>
          )}
          <RecentlyPlayedPlaylist />
        </div>
        <div className="space-y-4">
          <Suspense fallback={<LikedSongsSkeleton />}>
            <LikedSongsSection token={token} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

