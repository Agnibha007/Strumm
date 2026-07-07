"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import dynamic from "next/dynamic";
import { Plus, BookOpen, FilePlus2, Upload, X, Search } from "lucide-react";
import { Playlist } from "@strumm/types";
import { apiUrl, cleanText } from "web/lib/api";
import { useRouter } from "next/navigation";
import SongArtwork from "web/components/SongArtwork";

const PlaylistImport = dynamic(() => import("web/components/PlaylistImport"), {
  loading: () => (
    <div className="p-4 bg-surface/30 border border-border/40 rounded-lg animate-pulse">
      <div className="h-4 w-40 bg-border/40 rounded mb-3" />
      <div className="h-10 bg-border/30 rounded" />
    </div>
  ),
  ssr: false,
});

export default function PlaylistsPage() {
  const { token, user } = useAuthStore();
  const router = useRouter();
  const [userPlaylists, setUserPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [createMode, setCreateMode] = useState<null | "choose" | "empty" | "import">(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistDescription, setNewPlaylistDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredPlaylists = userPlaylists.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description && p.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const loadPlaylists = async () => {
    try {
      const response = await fetch(apiUrl("/playlists"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success && json.data) {
        setUserPlaylists(json.data);
      }
    } catch (e) {
      console.warn("Unable to fetch playlists offline.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaylists();
  }, [user]);

  const handleCreateEmptyPlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;

    setCreating(true);
    try {
      const response = await fetch(apiUrl("/playlists"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name: cleanText(newPlaylistName, 120),
          description: cleanText(newPlaylistDescription || "Personal playlist.", 1000)
        })
      });
      const json = await response.json();
      if (json.success && json.data) {
        setCreateMode(null);
        setNewPlaylistName("");
        setNewPlaylistDescription("");
        router.push(`/playlist/${json.data.id}`);
      } else {
        alert(json.error || "Failed to create playlist.");
      }
    } catch (e) {
      alert("Failed to connect to backend server.");
    } finally {
      setCreating(false);
    }
  };

  const PlaylistSkeleton = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, idx) => (
        <div key={idx} className="p-4 rounded-lg border border-border/40 bg-surface/30 space-y-4">
          <div className="w-full aspect-square rounded-lg bg-border/40 animate-pulse" />
          <div className="space-y-2">
            <div className="h-4 w-3/4 rounded bg-border/50 animate-pulse" />
            <div className="h-3 w-24 rounded bg-border/40 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-10 soft-enter">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Curation
          </span>
          <h2 className="text-3xl sm:text-4xl font-editorial text-text tracking-tight font-bold mt-1">
            Playlists
          </h2>
        </div>
        
        <button
          onClick={() => setCreateMode("choose")}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg shadow-md cursor-pointer transition"
        >
          <Plus className="w-4 h-4" />
          Create Playlist
        </button>
      </div>

      {createMode && (
        <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-border/20 pb-3">
            <h3 className="font-editorial text-xl text-text">
              {createMode === "choose" ? "Create Playlist" : createMode === "empty" ? "Empty Playlist" : "Import Playlist"}
            </h3>
            <button
              onClick={() => setCreateMode(null)}
              className="p-1.5 text-muted hover:text-text hover:bg-surface-elevated rounded transition"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {createMode === "choose" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                onClick={() => setCreateMode("empty")}
                className="p-5 rounded-lg bg-background/40 border border-border/50 hover:border-primary/40 hover:bg-surface-elevated/50 text-left transition cursor-pointer"
              >
                <FilePlus2 className="w-5 h-5 text-primary mb-4" />
                <div className="font-editorial text-lg text-text font-bold">Start Empty</div>
                <div className="text-xs text-muted mt-1">Create a clean playlist and add tracks from search.</div>
              </button>
              <button
                onClick={() => setCreateMode("import")}
                className="p-5 rounded-lg bg-background/40 border border-border/50 hover:border-primary/40 hover:bg-surface-elevated/50 text-left transition cursor-pointer"
              >
                <Upload className="w-5 h-5 text-primary mb-4" />
                <div className="font-editorial text-lg text-text font-bold">Import Playlist</div>
                <div className="text-xs text-muted mt-1">Bring in a CSV, Spotify link, or YouTube Music link.</div>
              </button>
            </div>
          )}

          {createMode === "empty" && (
            <form onSubmit={handleCreateEmptyPlaylist} className="space-y-4 max-w-xl">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">Name</label>
                <input
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50"
                  placeholder="Late night archive"
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">Description</label>
                <textarea
                  value={newPlaylistDescription}
                  onChange={(e) => setNewPlaylistDescription(e.target.value)}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50"
                  rows={3}
                  placeholder="A short note for this curation."
                />
              </div>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create Empty Playlist"}
              </button>
            </form>
          )}

          {createMode === "import" && (
            <PlaylistImport onImported={loadPlaylists} />
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 items-start">
        <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
          <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
            Your Curation Folder
          </h3>

          {loading ? (
            <PlaylistSkeleton />
          ) : userPlaylists.length === 0 ? (
            <p className="text-xs text-muted italic py-6">No playlists found. Build a custom record folder.</p>
          ) : (
            <div className="space-y-4">
              {userPlaylists.length > 0 && (
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-muted" />
                  </div>
                  <input
                    type="text"
                    placeholder="Search curations by name or description..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-background/50 border border-border/60 hover:border-border/80 focus:border-primary/50 rounded-xl pl-9 pr-9 py-2 text-xs text-text focus:outline-none transition shadow-sm"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-text cursor-pointer"
                      title="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              {filteredPlaylists.length === 0 ? (
                <div className="text-center py-10 border border-dashed border-border/40 rounded-xl bg-background/10">
                  <Search className="w-8 h-8 text-muted mx-auto mb-2" />
                  <p className="font-editorial text-base text-text">No playlists match your search</p>
                  <p className="text-[11px] text-muted">Try typing a different name or keyword.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredPlaylists.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => router.push(`/playlist/${p.id}`)}
                      className="p-4 rounded-lg bg-background/40 border border-border/40 hover:border-primary/40 hover:bg-surface-elevated/40 text-left cursor-pointer transition group soft-enter hover:-translate-y-0.5"
                    >
                      <div className="w-full aspect-square rounded-lg bg-surface-elevated overflow-hidden border border-border/40 shadow relative mb-4">
                        {p.songs.length === 1 ? (
                          <SongArtwork song={p.songs[0]} className="w-full h-full object-cover" />
                        ) : p.songs.length === 2 ? (
                          <div className="grid grid-cols-2 w-full h-full">
                            <SongArtwork song={p.songs[0]} className="w-full h-full object-cover" />
                            <SongArtwork song={p.songs[1]} className="w-full h-full object-cover" />
                          </div>
                        ) : p.songs.length === 3 ? (
                          <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
                            <div className="col-span-2 row-span-1 w-full h-full overflow-hidden">
                              <SongArtwork song={p.songs[0]} className="w-full h-full object-cover" />
                            </div>
                            <div className="col-span-1 w-full h-full overflow-hidden">
                              <SongArtwork song={p.songs[1]} className="w-full h-full object-cover" />
                            </div>
                            <div className="col-span-1 w-full h-full overflow-hidden">
                              <SongArtwork song={p.songs[2]} className="w-full h-full object-cover" />
                            </div>
                          </div>
                        ) : p.songs.length >= 4 ? (
                          <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
                            {p.songs.slice(0, 4).map((song, idx) => (
                              <SongArtwork key={`${song.videoId}-${idx}`} song={song} className="w-full h-full object-cover" />
                            ))}
                          </div>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <BookOpen className="w-10 h-10 text-accent/50" />
                          </div>
                        )}
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-editorial text-lg text-text font-bold leading-tight truncate group-hover:text-primary transition">{p.name}</div>
                          <div className="text-xs text-muted mt-1">{p.songs.length} songs</div>
                        </div>
                        <BookOpen className="w-4 h-4 text-muted group-hover:text-primary transition flex-shrink-0 mt-1" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
