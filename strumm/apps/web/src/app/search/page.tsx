"use client";

import { useEffect, useState, useRef } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Search, Play, Plus, Heart, Radio, FolderHeart, User, HelpCircle, X, Loader2, FolderPlus, Shuffle, Check } from "lucide-react";
import { Song, Playlist, PodcastShow } from "@strumm/types";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl, cleanText } from "web/lib/api";
import { searchYouTube, getPlaylistItems } from "web/lib/search";
import SongArtwork from "web/components/SongArtwork";
import { useNotificationStore } from "web/store/useNotificationStore";
import Link from "next/link";

export default function SearchPage() {
  const { token, user } = useAuthStore();
  const { playSong, addToQueue, queue, isRadio, triggerRadio } = usePlayerStore();
  const { show } = useNotificationStore();
  
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [trending] = useState<string[]>(["Lofi Beats", "Indian Classical", "Rain Ambient", "Electronic Focus", "Jazz Cafe"]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [activeFilter, setActiveFilter] = useState<"All" | "Songs" | "Artists" | "Albums" | "Podcasts" | "Playlists" | "Profiles">("All");
  const searchCacheRef = useRef<Record<string, any>>({});
  
  const [results, setResults] = useState<{
    songs: Song[];
    playlists: Playlist[];
    podcasts: PodcastShow[];
    users: any[];
    artists: any[];
    albums: any[];
  }>({
    songs: [],
    playlists: [],
    podcasts: [],
    users: [],
    artists: [],
    albums: []
  });

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Playlist addition states & effects
  const [userPlaylists, setUserPlaylists] = useState<Playlist[]>([]);
  const [addingToPlaylistSong, setAddingToPlaylistSong] = useState<Song | null>(null);

  // Album tracks state
  const [selectedAlbum, setSelectedAlbum] = useState<any | null>(null);
  const [albumTracks, setAlbumTracks] = useState<Song[]>([]);
  const [loadingAlbumTracks, setLoadingAlbumTracks] = useState(false);

  // Fetch album tracks when selectedAlbum changes (via Invidious playlist endpoint)
  useEffect(() => {
    if (!selectedAlbum) {
      setAlbumTracks([]);
      return;
    }
    const loadTracks = async () => {
      setLoadingAlbumTracks(true);
      try {
        const tracks = await getPlaylistItems(selectedAlbum.id);
        if (tracks.length > 0) {
          setAlbumTracks(tracks);
        } else {
          show("No tracks found for this album/playlist.", "warning");
        }
      } catch (e) {
        show("Failed to load album tracks.", "error");
      } finally {
        setLoadingAlbumTracks(false);
      }
    };
    loadTracks();
  }, [selectedAlbum]);

  const handlePlayAlbum = () => {
    if (albumTracks.length === 0) return;
    playSong(albumTracks[0], albumTracks);
  };

  const handleShuffleAlbum = () => {
    if (albumTracks.length === 0) return;
    const shuffled = [...albumTracks].sort(() => Math.random() - 0.5);
    playSong(shuffled[0], shuffled);
  };

  const loadUserPlaylists = async () => {
    if (!user) return;
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

  // 3. Search query debounce and execution with local cache
  // Uses Invidious API directly from the browser — no backend hop.
  useEffect(() => {
    if (!query.trim()) {
      setResults({ songs: [], playlists: [], podcasts: [], users: [], artists: [], albums: [] });
      return;
    }

    const categoryParam = activeFilter === "All" ? "" : activeFilter.toLowerCase();
    const cacheKey = `${query.trim()}:${categoryParam}`;

    if (searchCacheRef.current[cacheKey]) {
      setResults(searchCacheRef.current[cacheKey]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const q = cleanText(query, 120);

        if (activeFilter === "Profiles") {
          // User search still goes through backend (local MongoDB)
          try {
            const response = await fetch(apiUrl(`/users/search?q=${encodeURIComponent(q)}`));
            const json = await response.json();
            if (json.success) {
              const fetchedResults = {
                songs: [], playlists: [], podcasts: [], users: json.data || [], artists: [], albums: []
              };
              setResults(fetchedResults);
              searchCacheRef.current[cacheKey] = fetchedResults;
            }
          } catch { /* user search failed */ }
        } else {
          // Client-side search via Invidious API
          const type = getInvidiousTypeParam(activeFilter);
          const youtubeResults = await searchYouTube({ query: q, type });

          // Fetch podcasts from backend (separate route, not /search)
          let podcasts: PodcastShow[] = [];
          if (activeFilter === "All" || activeFilter === "Podcasts") {
            try {
              const podRes = await fetch(apiUrl(`/podcasts/shows?query=${encodeURIComponent(q)}&limit=6`));
              const podJson = await podRes.json();
              if (podJson.success) {
                podcasts = podJson.data || [];
              }
            } catch { /* podcast search offline */ }
          }

          // Fetch local Strumm playlists from backend (separate route, not /search)
          let playlists: Playlist[] = [];
          if (activeFilter === "All" || activeFilter === "Playlists") {
            try {
              const plRes = await fetch(apiUrl(`/playlists/search?q=${encodeURIComponent(q)}`));
              const plJson = await plRes.json();
              if (plJson.success) {
                playlists = plJson.data || [];
              }
            } catch { /* playlist search offline */ }
          }

          const fetchedResults = {
            songs: youtubeResults.songs || [],
            playlists,
            podcasts,
            users: [],
            artists: youtubeResults.artists || [],
            albums: youtubeResults.albums || [],
          };
          setResults(fetchedResults);
          searchCacheRef.current[cacheKey] = fetchedResults;

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
  }, [query, activeFilter]);

  function getInvidiousTypeParam(filter: string): "video" | "playlist" | "channel" | "all" {
    switch (filter) {
      case "Songs": return "video";
      case "Albums": return "playlist";
      case "Artists": return "channel";
      case "Playlists": return "playlist";
      default: return "all";
    }
  }

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
    <div className="space-y-10 max-w-6xl">
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

      {/* Filter Pills */}
      <div className="flex flex-wrap gap-2 overflow-x-auto pb-1 scrollbar-none">
        {(["All", "Songs", "Artists", "Albums", "Podcasts", "Playlists", "Profiles"] as const).map((filter) => (
          <button
            key={filter}
            onClick={() => setActiveFilter(filter)}
            className={`px-4 py-1.5 text-xs font-semibold rounded-full border transition cursor-pointer select-none whitespace-nowrap ${
              activeFilter === filter
                ? "bg-primary border-primary text-text shadow-lg"
                : "bg-surface/50 border-border/60 text-muted hover:border-border hover:text-text"
            }`}
          >
            {filter}
          </button>
        ))}
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
              (results.songs || []).length === 0 &&
              (results.playlists || []).length === 0 &&
              (results.podcasts || []).length === 0 &&
              (results.users || []).length === 0 &&
              (results.artists || []).length === 0 &&
              (results.albums || []).length === 0 && (
                <div className="text-center py-16 space-y-2 border border-dashed border-border/60 rounded-xl bg-surface/20">
                  <HelpCircle className="w-8 h-8 text-muted mx-auto" />
                  <p className="font-editorial text-lg text-text">No records found</p>
                  <p className="text-xs text-muted max-w-xs mx-auto">
                    Try checking spelling or exploring trending search terms.
                  </p>
                </div>
              )}

            {/* Render Song Matches */}
            {(activeFilter === "All" || activeFilter === "Songs") && results.songs.length > 0 && (
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
                      <div className="flex items-center gap-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                        <button
                          onClick={() => triggerRadio(song.videoId)}
                          className={`p-1.5 rounded-lg transition ${isRadio ? "text-primary text-glow" : "hover:bg-surface-elevated text-muted hover:text-primary"}`}
                          title={isRadio ? "Radio active" : "Start Radio from this song"}
                        >
                          <Radio className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleLikeSong(song)}
                          className="p-1.5 hover:bg-surface-elevated text-muted hover:text-primary rounded-lg transition"
                          title="Like track"
                        >
                          <Heart className="w-4 h-4" />
                        </button>
                        {(() => {
                          const isInQueue = queue.some((item) => item.videoId === song.videoId);
                          return (
                            <button
                              onClick={() => !isInQueue && addToQueue(song)}
                              className={`p-1.5 rounded-lg transition ${isInQueue ? "text-muted/40 cursor-default" : "hover:bg-surface-elevated text-muted hover:text-text cursor-pointer"}`}
                              title={isInQueue ? "Added to queue" : "Add to queue"}
                            >
                              {isInQueue ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                            </button>
                          );
                        })()}
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

            {/* Render Artists */}
            {(activeFilter === "All" || activeFilter === "Artists") && results.artists && results.artists.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Artists
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.artists.map((artist) => (
                    <div
                      key={artist.id}
                      className="p-4 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-center"
                    >
                      <div className="w-16 h-16 rounded-full bg-surface-elevated overflow-hidden border border-border/60 mx-auto relative shadow flex items-center justify-center">
                        {artist.thumbnail ? (
                          <img src={artist.thumbnail} alt={artist.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-6 h-6 text-accent/65" />
                        )}
                      </div>
                      <div className="text-xs font-semibold text-text mt-3.5 truncate leading-tight">
                        {artist.name}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Render Albums */}
            {(activeFilter === "All" || activeFilter === "Albums") && results.albums && results.albums.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Albums
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.albums.map((album) => (
                    <div
                      key={album.id}
                      onClick={() => setSelectedAlbum(album)}
                      className="p-3 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-left font-sans cursor-pointer"
                    >
                      <div className="w-full aspect-square rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow relative">
                        {album.thumbnail ? (
                          <img src={album.thumbnail} alt={album.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        ) : (
                          <FolderHeart className="w-8 h-8 text-accent/60 mx-auto mt-8" />
                        )}
                      </div>
                      <div className="font-editorial text-sm text-text font-bold mt-3.5 truncate">
                        {album.title}
                      </div>
                      <div className="text-[10px] text-muted truncate mt-1">
                        By {album.artist} {album.year ? `• ${album.year}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Render Playlists */}
            {(activeFilter === "All" || activeFilter === "Playlists") && results.playlists.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Shared Playlists
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.playlists.map((playlist) => (
                    <Link
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
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Render Podcast Shows */}
            {(activeFilter === "All" || activeFilter === "Podcasts") && results.podcasts.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Podcast Feeds
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.podcasts.map((podcast) => (
                    <Link
                      key={podcast.id}
                      href={`/podcasts/show/${podcast.id}`}
                      className="p-3 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-left block"
                    >
                      <div className="w-full aspect-square rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow relative">
                        <img src={podcast.image} alt={podcast.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
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
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Render Users / Curators */}
            {(activeFilter === "All" || activeFilter === "Profiles") && results.users.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                  Strumm Curators
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                  {results.users.map((curator) => (
                    <Link
                      key={curator.id}
                      href={`/profile?username=${curator.username}`}
                      className="p-4 bg-surface/30 border border-border/40 rounded-xl hover:bg-surface hover:border-border/80 transition text-center block"
                    >
                      <div className="w-16 h-16 rounded-full bg-surface-elevated overflow-hidden border border-border/60 mx-auto relative shadow flex items-center justify-center">
                        {curator.avatar ? (
                          <img src={curator.avatar} alt={curator.displayName} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
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
                    </Link>
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
          <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
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

      {/* Album Tracks Overlay/Modal */}
      <AnimatePresence>
        {selectedAlbum && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-surface border border-border/80 rounded-2xl p-6 max-w-2xl w-full shadow-2xl space-y-6 relative flex flex-col max-h-[85vh] overflow-hidden"
            >
              {/* Header section */}
              <div className="flex justify-between items-start gap-4">
                <div className="flex gap-4 min-w-0">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow-md relative flex-shrink-0">
                    {selectedAlbum.thumbnail ? (
                      <img src={selectedAlbum.thumbnail} alt={selectedAlbum.title} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted">
                        <FolderHeart className="w-8 h-8 text-accent/60" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex flex-col justify-center text-left">
                    <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
                      Album Release
                    </span>
                    <h3 className="font-editorial text-xl sm:text-2xl text-text font-bold leading-tight mt-1 truncate">
                      {selectedAlbum.title}
                    </h3>
                    <p className="text-xs sm:text-sm text-muted mt-1 truncate">
                      By {selectedAlbum.artist} {selectedAlbum.year ? `• ${selectedAlbum.year}` : ""}
                    </p>
                    <div className="flex gap-2.5 mt-3 flex-wrap">
                      <button
                        onClick={handlePlayAlbum}
                        disabled={loadingAlbumTracks || albumTracks.length === 0}
                        className="px-4 py-1.5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition cursor-pointer select-none"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Play
                      </button>
                      <button
                        onClick={handleShuffleAlbum}
                        disabled={loadingAlbumTracks || albumTracks.length === 0}
                        className="px-4 py-1.5 bg-surface-elevated hover:bg-surface-elevated/80 border border-border/40 disabled:opacity-50 text-text text-xs font-semibold rounded-lg flex items-center gap-1.5 transition cursor-pointer select-none"
                      >
                        <Shuffle className="w-3.5 h-3.5" />
                        Shuffle
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedAlbum(null)}
                  className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-md transition cursor-pointer flex-shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Tracks List */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 text-left min-h-[200px]">
                {loadingAlbumTracks ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <span className="text-xs uppercase tracking-widest">Retrieving tracklists...</span>
                  </div>
                ) : albumTracks.length === 0 ? (
                  <p className="text-xs text-muted py-12 text-center italic">No songs found in this album.</p>
                ) : (
                  albumTracks.map((song, idx) => {
                    const formatDuration = (sec: number) => {
                      const m = Math.floor(sec / 60);
                      const s = Math.floor(sec % 60);
                      return `${m}:${s < 10 ? "0" : ""}${s}`;
                    };
                    return (
                      <div
                        key={song.videoId}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-surface-elevated/20 border border-border/20 hover:border-border/60 hover:bg-surface-elevated/40 transition group gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xs font-mono text-muted w-5 text-center flex-shrink-0">{idx + 1}</span>
                          <button
                            onClick={() => playSong(song, albumTracks)}
                            className="p-1.5 bg-primary/10 border border-primary/20 text-primary hover:bg-primary hover:text-white rounded-lg transition flex-shrink-0"
                          >
                            <Play className="w-3 h-3 fill-current" />
                          </button>
                          <div className="min-w-0 text-left">
                            <span className="text-xs sm:text-sm font-semibold text-text block truncate">{song.title}</span>
                            <span className="text-[10px] text-muted block truncate mt-0.5">{song.artist}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="text-[11px] font-mono text-muted">{formatDuration(song.duration)}</span>
                          <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                            <button
                              onClick={() => handleLikeSong(song)}
                              className="p-1 hover:bg-surface-elevated text-muted hover:text-primary rounded-md transition"
                              title="Like track"
                            >
                              <Heart className="w-3.5 h-3.5" />
                            </button>
                            {(() => {
                              const isInQueue = queue.some((item) => item.videoId === song.videoId);
                              return (
                                <button
                                  onClick={() => !isInQueue && addToQueue(song)}
                                  className={`p-1 rounded-md transition ${isInQueue ? "text-muted/40 cursor-default" : "hover:bg-surface-elevated text-muted hover:text-text cursor-pointer"}`}
                                  title={isInQueue ? "Added to queue" : "Add to queue"}
                                >
                                  {isInQueue ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                                </button>
                              );
                            })()}
                            <button
                              onClick={() => {
                                setAddingToPlaylistSong(song);
                              }}
                              className="p-1 hover:bg-surface-elevated text-muted hover:text-accent rounded-md transition"
                              title="Add to playlist"
                            >
                              <FolderPlus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
