"use client";

import { useEffect, useState, useRef } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Search, Play, Plus, Heart, Radio, FolderHeart, User, HelpCircle, X, Loader2, FolderPlus } from "lucide-react";
import { Song, Playlist, PodcastShow } from "@strumm/types";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl, cleanText } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";
import { useNotificationStore } from "web/store/useNotificationStore";

export default function SearchPage() {
  const { token } = useAuthStore();
  const { playSong, addToQueue } = usePlayerStore();
  const { show } = useNotificationStore();
  
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [trending, setTrending] = useState<string[]>(["Lofi Beats", "Indian Classical", "Rain Ambient", "Electronic Focus", "Jazz Cafe"]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [results, setResults] = useState<{
    songs: Song[];
    playlists: Playlist[];
    podcasts: PodcastShow[];
    users: any[];
  }>({
    songs: [],
    playlists: [],
    podcasts: [],
    users: []
  });

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Playlist addition states & effects
  const [userPlaylists, setUserPlaylists] = useState<Playlist[]>([]);
  const [addingToPlaylistSong, setAddingToPlaylistSong] = useState<Song | null>(null);

  const loadUserPlaylists = async () => {
    if (!token) return;
    try {
      const response = await fetch(apiUrl("/playlists"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success && json.data) {
        setUserPlaylists(json.data);
      }
    } catch (e) {
      console.warn("Unable to fetch playlists for search selection.");
    }
  };

  useEffect(() => {
    loadUserPlaylists();
  }, [token]);

  const handleAddSongToPlaylist = async (playlistId: string, song: Song) => {
    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(playlistId)}/songs`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ song })
      });
      const json = await response.json();
      if (json.success) {
        show(`Added "${song.title}" to playlist!`, "success");
        setAddingToPlaylistSong(null);
        loadUserPlaylists();
      } else {
        show(json.error || "Failed to add song to playlist.", json.error?.includes("already") ? "warning" : "error");
      }
    } catch (e) {
      show("Failed to connect to backend server.", "error");
    }
  };

  // 1. Keyboard shortcut: Ctrl + K to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 2. Load recent searches from localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem("strumm-recent-searches");
      if (cached) {
        setRecentSearches(JSON.parse(cached));
      }
    }
  }, []);

  // 3. Search query debounce and execution
  useEffect(() => {
    if (!query.trim()) {
      setResults({ songs: [], playlists: [], podcasts: [], users: [] });
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(apiUrl(`/search?q=${encodeURIComponent(cleanText(query, 120))}`));
        const json = await response.json();
        if (json.success && json.data) {
          setResults(json.data.results);
          if (json.data.trending) {
            setTrending(json.data.trending);
          }
          // Save to smart search history
          if (query.trim().length >= 2) {
            saveRecentSearch(query.trim());
          }
        }
      } catch (err) {
        console.warn("Search request failed.");
      } finally {
        setLoading(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [query]);

  // 4. Save recent searches
  const saveRecentSearch = (term: string) => {
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem("strumm-recent-searches");
      const current = cached ? JSON.parse(cached) : [];
      const updated = [term, ...current.filter((t: string) => t !== term)].slice(0, 10);
      localStorage.setItem("strumm-recent-searches", JSON.stringify(updated));
      setRecentSearches(updated);
    }
  };

  const handleSelectSearchTerm = (term: string) => {
    setQuery(term);
    saveRecentSearch(term);
  };

  const clearRecentSearch = (term: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = recentSearches.filter((t) => t !== term);
    setRecentSearches(updated);
    if (typeof window !== "undefined") {
      localStorage.setItem("strumm-recent-searches", JSON.stringify(updated));
    }
  };

  const handleLikeSong = async (song: Song) => {
    try {
      const response = await fetch(apiUrl("/liked"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(song)
      });
      const json = await response.json();
      if (json.success) {
        show(json.data.message, "success");
      }
    } catch (e) {
      show("Failed to update liked songs.", "error");
    }
  };

  return (
    <div className="space-y-10 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Universal Portal
        </span>
        <h2 className="text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Search Directory
        </h2>
      </div>

      {/* Input */}
      <div className="relative">
        <Search className="absolute left-4.5 top-4 w-5 h-5 text-muted" />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search songs, artists, playlists, podcasts, curators..."
          className="w-full bg-surface border border-border/80 rounded-xl pl-12 pr-24 py-3.5 text-base text-text focus:outline-none focus:border-primary/50 transition font-sans shadow-lg"
        />
        <div className="absolute right-4.5 top-3.5 flex items-center gap-2">
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded-md transition"
            >
              <X className="w-4.5 h-4.5" />
            </button>
          )}
          <span className="hidden sm:inline-block px-2 py-1 text-[9px] font-bold text-muted bg-surface-elevated border border-border/60 rounded-md font-mono select-none">
            Ctrl + K
          </span>
        </div>
      </div>

      {/* Main Results / Recommendations */}
      <AnimatePresence mode="wait">
        {!query.trim() ? (
          <motion.div
            key="suggestions"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-10"
          >
            {/* Recent searches */}
            {recentSearches.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-lg text-text border-b border-border/20 pb-2">
                  Recent Curations
                </h3>
                <div className="space-y-1">
                  {recentSearches.map((term) => (
                    <div
                      key={term}
                      onClick={() => handleSelectSearchTerm(term)}
                      className="flex items-center justify-between p-3 rounded-lg bg-surface/30 hover:bg-surface border border-border/20 hover:border-border/60 text-sm text-text cursor-pointer transition select-none"
                    >
                      <span className="font-medium">{term}</span>
                      <button
                        onClick={(e) => clearRecentSearch(term, e)}
                        className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded transition"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trending terms */}
            <div className="space-y-4">
              <h3 className="font-editorial text-lg text-text border-b border-border/20 pb-2">
                Trending Waves
              </h3>
              <div className="flex flex-wrap gap-2.5">
                {trending.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSelectSearchTerm(term)}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-surface/40 hover:bg-primary/10 border border-border/40 hover:border-primary/20 text-muted hover:text-primary transition cursor-pointer select-none"
                  >
                    {term}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-10"
          >
            {loading && (
              <div className="flex items-center justify-center py-6 gap-2 text-xs text-muted">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>Searching archives...</span>
              </div>
            )}

            {!loading &&
              results.songs.length === 0 &&
              results.playlists.length === 0 &&
              results.podcasts.length === 0 &&
              results.users.length === 0 && (
                <div className="text-center py-16 space-y-2 border border-dashed border-border/60 rounded-xl bg-surface/20">
                  <HelpCircle className="w-8 h-8 text-muted mx-auto" />
                  <p className="font-editorial text-lg text-text">No records found</p>
                  <p className="text-xs text-muted max-w-xs mx-auto">
                    Try checking spelling or exploring trending search terms.
                  </p>
                </div>
              )}

            {/* Render Song Matches */}
            {results.songs.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Song Results
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {results.songs.map((song) => (
                    <div
                      key={song.videoId}
                      className="flex items-center gap-4 p-3 bg-surface/40 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition group relative"
                    >
                      <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 shadow">
                        <SongArtwork song={song} className="w-full h-full" />
                        <button
                          onClick={() => playSong(song, results.songs)}
                          className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                        >
                          <Play className="w-5 h-5 text-white fill-current" />
                        </button>
                      </div>
                      <div className="min-w-0 flex-grow text-left">
                        <div className="text-sm font-semibold text-text truncate">{song.title}</div>
                        <div className="text-xs text-muted truncate mt-0.5">{song.artist}</div>
                      </div>
                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition">
                        <button
                          onClick={() => handleLikeSong(song)}
                          className="p-1.5 hover:bg-surface-elevated text-muted hover:text-primary rounded-lg transition"
                          title="Like track"
                        >
                          <Heart className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => addToQueue(song)}
                          className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition"
                          title="Add to queue"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setAddingToPlaylistSong(song)}
                          className="p-1.5 hover:bg-surface-elevated text-muted hover:text-accent rounded-lg transition"
                          title="Add to playlist"
                        >
                          <FolderPlus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Render Playlists */}
            {results.playlists.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Shared Playlists
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.playlists.map((playlist) => (
                    <a
                      key={playlist.id}
                      href={`/playlist/${playlist.id}`}
                      className="p-3 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-left block"
                    >
                      <div className="w-full aspect-square rounded-lg bg-surface-elevated flex items-center justify-center border border-border/40 overflow-hidden relative shadow">
                        <FolderHeart className="w-8 h-8 text-accent/60" />
                      </div>
                      <div className="font-editorial text-sm text-text font-bold mt-3.5 truncate">
                        {playlist.name}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-1">
                        {playlist.followers || 0} followers
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Render Podcast Shows */}
            {results.podcasts.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Podcast Feeds
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.podcasts.map((podcast) => (
                    <a
                      key={podcast.id}
                      href={`/podcasts/show/${podcast.id}`}
                      className="p-3 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-left block"
                    >
                      <div className="w-full aspect-square rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow relative">
                        <img src={podcast.image} alt={podcast.title} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        <div className="absolute right-2 bottom-2 p-1.5 bg-black/60 rounded-full">
                          <Radio className="w-3.5 h-3.5 text-primary" />
                        </div>
                      </div>
                      <div className="font-editorial text-sm text-text font-bold mt-3.5 truncate">
                        {podcast.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-1">
                        By {podcast.author}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Render Users / Curators */}
            {results.users.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Strumm Curators
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.users.map((curator) => (
                    <a
                      key={curator.id}
                      href={`/profile?username=${curator.username}`}
                      className="p-4 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-center block"
                    >
                      <div className="w-16 h-16 rounded-full bg-surface-elevated overflow-hidden border border-border/60 mx-auto relative shadow flex items-center justify-center">
                        {curator.avatar ? (
                          <img src={curator.avatar} alt={curator.displayName} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-6 h-6 text-accent/65" />
                        )}
                      </div>
                      <div className="text-xs font-semibold text-text mt-3.5 truncate leading-tight">
                        {curator.displayName}
                      </div>
                      <div className="text-[9px] text-muted truncate mt-0.5">
                        @{curator.username}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Add to Playlist Modal */}
      <AnimatePresence>
        {addingToPlaylistSong && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-surface border border-border/80 rounded-xl p-6 max-w-sm w-full shadow-2xl space-y-4 relative"
            >
              <div className="flex justify-between items-center border-b border-border/20 pb-3">
                <h3 className="font-editorial text-lg text-text font-bold">Add to Playlist</h3>
                <button
                  onClick={() => setAddingToPlaylistSong(null)}
                  className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded-md transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto">
                {userPlaylists.length === 0 ? (
                  <p className="text-xs text-muted py-4 text-center italic">No playlists created yet. Create one in the Playlists section!</p>
                ) : (
                  userPlaylists.map((playlist) => (
                    <button
                      key={playlist.id}
                      onClick={() => handleAddSongToPlaylist(playlist.id, addingToPlaylistSong)}
                      className="w-full text-left p-3 rounded-lg bg-surface-elevated hover:bg-primary/10 border border-border/40 hover:border-primary/20 transition cursor-pointer text-sm font-semibold text-text flex items-center justify-between"
                    >
                      <span>{playlist.name}</span>
                      <span className="text-[10px] text-muted">{playlist.songs.length} tracks</span>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
