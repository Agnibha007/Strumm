"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl, cleanText } from "web/lib/api";
import { searchYouTube } from "web/lib/search";
import SongArtwork from "web/components/SongArtwork";
import Link from "next/link";

import { Search, Play, Heart, Sparkles, Loader2, ListMusic, Radio } from "lucide-react";
import { Song } from "@strumm/types";

import LoginPage from "./login/page";

export default function HomePage() {
  const { user } = useAuthStore();
  const { playSong, isRadio, triggerRadio } = usePlayerStore();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Song[]>([]);
  const [, setSearchLoading] = useState(false);

  const [recommendations, setRecommendations] = useState<Song[]>([]);
  const [likedSongs, setLikedSongs] = useState<Song[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);

  // Perform search queries on typing (directly from browser via Invidious API)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delayDebounce = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await searchYouTube({
          query: cleanText(searchQuery, 120),
          type: "video"
        });
        setSearchResults(results.songs || []);
      } catch (e) {
        console.warn("Search API offline.");
      } finally {
        setSearchLoading(false);
      }
    }, 400);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  useEffect(() => {
    if (!user) return;

    const loadHomeData = async () => {
      setHomeLoading(true);
      try {
        const { token } = useAuthStore.getState();
        // Fetch AI recommendations
        const discoverResp = await fetch(apiUrl("/explore-mix"), {
          headers: token ? { "Authorization": `Bearer ${token}` } : undefined,
        });
        const discoverJson = await discoverResp.json();
        if (discoverJson.success && discoverJson.data) {
          setRecommendations(discoverJson.data.songs || []);
        }

        // Fetch Liked Songs
        const likedResp = await fetch(apiUrl("/liked?limit=10"), {
          headers: token ? { "Authorization": `Bearer ${token}` } : undefined,
        });
        const likedJson = await likedResp.json();
        if (likedJson.success && likedJson.data) {
          setLikedSongs(likedJson.data.map((item: any) => item.song) || []);
        }
      } catch (e) {
        console.warn("Failed to load home data.");
      } finally {
        setHomeLoading(false);
      }
    };

    loadHomeData();
  }, [user]);

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="space-y-10 max-w-7xl mx-auto pb-10">
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

      {homeLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-xs uppercase tracking-widest">Curating your space...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* AI Discovery Mix */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-border/20 pb-2">
              <h3 className="font-editorial text-2xl text-text font-bold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Discovery Mix
              </h3>
              <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">Adaptive</span>
            </div>
            
            {recommendations.length === 0 ? (
              <div className="text-center py-10 bg-surface/30 border border-border/40 rounded-xl">
                <p className="text-xs text-muted">No recommendations available yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {recommendations.map((song, idx) => (
                  <div
                    key={`rec-${song.videoId}-${idx}`}
                    className="p-3 bg-surface/40 border border-border/40 hover:bg-surface hover:border-border/80 rounded-xl transition group"
                  >
                    <div className="flex items-center gap-3 text-left w-full cursor-pointer">
                      <button
                        onClick={() => playSong(song, recommendations)}
                        className="flex items-center gap-3 flex-1 min-w-0"
                      >
                        <div className="w-12 h-12 rounded overflow-hidden flex-shrink-0 relative">
                          <SongArtwork song={song} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Play className="w-4 h-4 text-white fill-current" />
                          </div>
                        </div>
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
                        className={`p-2 rounded-lg transition flex-shrink-0 self-center ${isRadio ? "text-primary text-glow" : "text-muted hover:text-primary opacity-0 group-hover:opacity-100"}`}
                        title={isRadio ? "Radio active" : "Start Radio from this song"}
                      >
                        <Radio className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Strumm Flow Promo Card */}
            <div className="bg-surface/30 border border-border/40 rounded-2xl p-6 flex flex-col items-center text-center shadow-sm backdrop-blur-md mt-4 space-y-4">
              <div className="p-3.5 bg-primary/10 rounded-full text-primary">
                <Sparkles className="w-6 h-6 animate-pulse" />
              </div>
              <div className="space-y-1">
                <h4 className="font-editorial text-lg font-bold text-text">Strumm Flow Assistant</h4>
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
            </div>
          </div>

          {/* Liked Songs */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-border/20 pb-2">
              <h3 className="font-editorial text-2xl text-text font-bold flex items-center gap-2">
                <Heart className="w-5 h-5 text-red-500 fill-current" />
                Your Liked Songs
              </h3>
              <Link href="/library" className="text-[10px] text-muted uppercase tracking-wider font-semibold hover:text-text transition">View All</Link>
            </div>
            
            {likedSongs.length === 0 ? (
              <div className="text-center py-10 bg-surface/30 border border-border/40 rounded-xl">
                <p className="text-xs text-muted">You haven&apos;t liked any songs yet.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {likedSongs.map((song, idx) => (
                  <button
                    key={`liked-${song.videoId}-${idx}`}
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
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
