"use client";

import { useEffect, useState, use } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Play, Shuffle, Plus, Heart, Trash2, Edit3, Share2, Music, Clock, FolderHeart, ArrowLeft, Loader2, Save, X, Search, Check, Users, UserPlus, UserMinus, Radio } from "lucide-react";
import { Playlist, Song } from "@strumm/types";
import { useRouter } from "next/navigation";
import { apiUrl, cleanText } from "web/lib/api";
import SongArtwork from "web/components/SongArtwork";

interface PlaylistDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function PlaylistDetailPage({ params }: PlaylistDetailPageProps) {
  const { id } = use(params);
  const { token, user } = useAuthStore();
  const { playSong, setQueue, addToQueue, queue, isRadio, triggerRadio } = usePlayerStore();
  const router = useRouter();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit states
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editVisibility, setEditVisibility] = useState<"public" | "private">("private");

  // Collaborator management
  const [showCollabModal, setShowCollabModal] = useState(false);
  const [collabUserId, setCollabUserId] = useState("");
  const [collabAction, setCollabAction] = useState<"add" | "remove">("add");

  // Search filter state
  const [searchQuery, setSearchQuery] = useState("");

  const loadPlaylist = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}`), {
        headers: token ? { "Authorization": `Bearer ${token}` } : {}
      });
      const json = await response.json();
      if (json.success && json.data) {
        setPlaylist(json.data);
        setEditName(json.data.name);
        setEditDesc(json.data.description || "");
        setEditVisibility(json.data.visibility);
      } else {
        setError(json.error || "Failed to load playlist.");
      }
    } catch (e) {
      setError("Unable to connect to backend server.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) {
      loadPlaylist();
    }
  }, [id, token]);

  const handlePlayAll = () => {
    const targetSongs = searchQuery ? filteredSongs : (playlist?.songs || []);
    if (targetSongs.length === 0) return;
    playSong(targetSongs[0], targetSongs);
  };

  const handleShufflePlay = () => {
    const targetSongs = searchQuery ? filteredSongs : (playlist?.songs || []);
    if (targetSongs.length === 0) return;
    const shuffled = [...targetSongs].sort(() => Math.random() - 0.5);
    playSong(shuffled[0], shuffled);
  };

  const handleSaveChanges = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}`), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name: cleanText(editName, 120),
          description: cleanText(editDesc, 1000),
          visibility: editVisibility
        })
      });
      const json = await response.json();
      if (json.success && json.data) {
        setPlaylist(json.data);
        setIsEditing(false);
      } else {
        alert(json.error || "Failed to save changes.");
      }
    } catch (e) {
      alert("Failed to connect to backend server.");
    }
  };

  const handleDeletePlaylist = async () => {
    const confirmed = confirm("Are you sure you want to delete this playlist? This action is permanent.");
    if (!confirmed) return;

    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        router.push("/playlists");
      } else {
        alert(json.error || "Failed to delete playlist.");
      }
    } catch (e) {
      alert("Failed to connect to backend server.");
    }
  };

  const handleSharePlaylist = async () => {
    try {
      const response = await fetch(apiUrl("/share"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          contentType: "playlist",
          contentId: id
        })
      });
      const json = await response.json();
      if (json.success && json.data) {
        const fullShareUrl = window.location.origin + json.data.shareUrl;
        await navigator.clipboard.writeText(fullShareUrl);
        alert(`Share link copied to clipboard:\n${fullShareUrl}`);
      } else {
        alert(json.error || "Failed to generate share link.");
      }
    } catch (e) {
      alert("Failed to connect to backend server.");
    }
  };

  const handleRemoveTrack = async (songIndex: number) => {
    if (!playlist) return;
    const confirmed = confirm("Remove this track from the playlist?");
    if (!confirmed) return;

    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}/songs/${songIndex}`), {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      const json = await response.json();
      if (json.success && json.data) {
        setPlaylist(json.data);
      } else {
        alert(json.error || "Failed to remove track.");
      }
    } catch (e) {
      alert("Failed to connect to backend server.");
    }
  };

  const handleManageCollab = async () => {
    if (!token || !collabUserId.trim()) return;
    try {
      const response = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}/collaborators`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          collaboratorId: collabUserId.trim(),
          action: collabAction
        })
      });
      const json = await response.json();
      if (json.success) {
        setShowCollabModal(false);
        setCollabUserId("");
        loadPlaylist();
      } else {
        alert(json.error || "Failed to manage collaborator.");
      }
    } catch (e) {
      alert("Failed to connect to backend.");
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
        alert(json.data.message);
      }
    } catch (e) {
      alert("Failed to update liked songs.");
    }
  };

  const formatDuration = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours} hr ${minutes} min`;
    }
    return `${minutes} min ${seconds} sec`;
  };

  if (loading) {
    return (
      <div className="space-y-10 max-w-5xl mx-auto">
        <div className="h-4 w-32 rounded bg-border/50 animate-pulse" />
        <div className="flex flex-col md:flex-row items-center md:items-end gap-8 pb-4">
          <div className="w-48 h-48 md:w-56 md:h-56 rounded-xl bg-border/40 animate-pulse flex-shrink-0" />
          <div className="flex-grow space-y-4 w-full">
            <div className="h-3 w-28 rounded bg-border/50 animate-pulse mx-auto md:mx-0" />
            <div className="h-12 w-full max-w-md rounded bg-border/50 animate-pulse mx-auto md:mx-0" />
            <div className="h-4 w-full max-w-lg rounded bg-border/40 animate-pulse mx-auto md:mx-0" />
            <div className="h-3 w-64 rounded bg-border/40 animate-pulse mx-auto md:mx-0" />
          </div>
        </div>
        <div className="border-y border-border/20 py-4 flex gap-3">
          <div className="h-10 w-28 rounded-lg bg-border/50 animate-pulse" />
          <div className="h-10 w-28 rounded-lg bg-border/40 animate-pulse" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border/60 bg-surface/20">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="flex items-center gap-4 p-4 border-b border-border/20 last:border-0">
              <div className="h-3 w-5 rounded bg-border/40 animate-pulse" />
              <div className="w-8 h-8 rounded bg-border/50 animate-pulse" />
              <div className="space-y-2 flex-1">
                <div className="h-3 w-1/2 rounded bg-border/50 animate-pulse" />
                <div className="h-2.5 w-1/4 rounded bg-border/40 animate-pulse" />
              </div>
              <div className="h-3 w-10 rounded bg-border/40 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !playlist) {
    return (
      <div className="text-center py-20 space-y-4">
        <FolderHeart className="w-12 h-12 text-muted mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Unable to resolve folder</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">{error || "Curation folder does not exist or is private."}</p>
        <button
          onClick={() => router.push("/playlists")}
          className="px-4 py-2 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-lg transition flex items-center gap-2 mx-auto cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Curation List
        </button>
      </div>
    );
  }

  const isOwner = user && playlist.userId === user.id;

  const filteredSongs = playlist
    ? playlist.songs.filter(
        (song) =>
          song.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          song.artist.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [];

  const totalDuration = playlist.songs.reduce((acc, song) => acc + song.duration, 0);

  return (
    <div className="space-y-10 max-w-5xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => router.push("/playlists")}
        className="flex items-center gap-2 text-muted hover:text-text transition text-xs font-semibold select-none cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Playlists
      </button>

      {/* Playlist Hero Info Section */}
      <div className="flex flex-col md:flex-row items-center md:items-end gap-8 pb-4">
        {/* Cover Art */}
        <div className="w-48 h-48 md:w-56 md:h-56 rounded-xl bg-surface-elevated flex items-center justify-center border border-border/80 relative shadow-2xl overflow-hidden flex-shrink-0">
          {playlist.songs.length === 1 ? (
            <SongArtwork song={playlist.songs[0]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 192px, 224px" />
          ) : playlist.songs.length === 2 ? (
            <div className="grid grid-cols-2 w-full h-full">
              <SongArtwork song={playlist.songs[0]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 96px, 112px" />
              <SongArtwork song={playlist.songs[1]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 96px, 112px" />
            </div>
          ) : playlist.songs.length === 3 ? (
            <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
              <div className="col-span-2 row-span-1 w-full h-full overflow-hidden">
                <SongArtwork song={playlist.songs[0]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 192px, 224px" />
              </div>
              <div className="col-span-1 w-full h-full overflow-hidden">
                <SongArtwork song={playlist.songs[1]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 96px, 112px" />
              </div>
              <div className="col-span-1 w-full h-full overflow-hidden">
                <SongArtwork song={playlist.songs[2]} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 96px, 112px" />
              </div>
            </div>
          ) : playlist.songs.length >= 4 ? (
            <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
              {playlist.songs.slice(0, 4).map((s, idx) => (
                <SongArtwork key={idx} song={s} className="w-full h-full object-cover" priority sizes="(max-width: 768px) 96px, 112px" />
              ))}
            </div>
          ) : (
            <FolderHeart className="w-16 h-16 text-accent/60" />
          )}
        </div>

        {/* Text Details */}
        <div className="text-center md:text-left flex-grow space-y-4">
          <div className="space-y-2">
            <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
              {playlist.visibility === "public" ? "Public Playlist" : "Private Curation"}
            </span>
            {isEditing ? (
              <form onSubmit={handleSaveChanges} className="space-y-3">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-lg text-text focus:outline-none focus:border-primary/50"
                  required
                />
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary/50"
                  rows={2}
                  placeholder="Playlist description"
                />
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                    <input
                      type="radio"
                      name="visibility"
                      checked={editVisibility === "public"}
                      onChange={() => setEditVisibility("public")}
                      className="accent-primary"
                    />
                    Public
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                    <input
                      type="radio"
                      name="visibility"
                      checked={editVisibility === "private"}
                      onChange={() => setEditVisibility("private")}
                      className="accent-primary"
                    />
                    Private
                  </label>
                </div>
                <div className="flex gap-2 justify-end md:justify-start">
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 bg-text text-background font-editorial text-xs font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="px-3.5 py-1.5 border border-border text-text text-xs font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h1 className="text-4xl md:text-5xl font-editorial font-bold text-text tracking-tight">
                  {playlist.name}
                </h1>
                <p className="text-sm text-muted max-w-xl">
                  {playlist.description || "No description provided."}
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-4 gap-y-1.5 text-xs text-muted">
            <span className="font-semibold text-text">Strumm Curator</span>
            <span>&bull;</span>
            <span>{playlist.songs.length} tracks</span>
            <span>&bull;</span>
            <span>{formatDuration(totalDuration)}</span>
            {playlist.followers > 0 && (
              <>
                <span>&bull;</span>
                <span>{playlist.followers} followers</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Playlist Actions Menu */}
      <div className="border-y border-border/20 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={handlePlayAll}
            disabled={playlist.songs.length === 0}
            className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center gap-2 shadow-md cursor-pointer transition select-none disabled:opacity-50"
          >
            <Play className="w-4 h-4 fill-current" />
            Play Folder
          </button>
          <button
            onClick={handleShufflePlay}
            disabled={playlist.songs.length === 0}
            className="px-5 py-2.5 bg-surface-elevated hover:bg-surface border border-border/80 text-text text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer transition select-none disabled:opacity-50"
          >
            <Shuffle className="w-4 h-4" />
            Shuffle Play
          </button>
        </div>

        <div className="flex items-center gap-2">
          {isOwner && !isEditing && (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="p-2 hover:bg-surface-elevated text-muted hover:text-text rounded-lg border border-transparent hover:border-border transition"
                title="Edit details"
              >
                <Edit3 className="w-4.5 h-4.5" />
              </button>
              <button
                onClick={() => { setCollabAction("add"); setCollabUserId(""); setShowCollabModal(true); }}
                className="p-2 hover:bg-accent/10 text-muted hover:text-accent rounded-lg border border-transparent hover:border-accent/20 transition"
                title="Manage Collaborators"
              >
                <Users className="w-4.5 h-4.5" />
              </button>
              <button
                onClick={handleDeletePlaylist}
                className="p-2 hover:bg-primary/10 text-muted hover:text-primary rounded-lg border border-transparent hover:border-primary/20 transition"
                title="Delete playlist"
              >
                <Trash2 className="w-4.5 h-4.5" />
              </button>
            </>
          )}
          <button
            onClick={handleSharePlaylist}
            className="p-2 hover:bg-surface-elevated text-muted hover:text-text rounded-lg border border-transparent hover:border-border transition"
            title="Copy share link"
          >
            <Share2 className="w-4.5 h-4.5" />
          </button>
        </div>
      </div>

      {/* Song list layout */}
      <div className="space-y-4">
        {playlist.songs.length > 0 && (
          <div className="relative flex items-center gap-3">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-muted" />
              </div>
              <input
                type="text"
                placeholder="Search tracks inside this playlist by title or artist..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-surface/30 border border-border/60 hover:border-border/80 focus:border-primary/50 rounded-xl pl-10 pr-10 py-2.5 text-xs text-text focus:outline-none transition shadow-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-muted hover:text-text cursor-pointer"
                  title="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {searchQuery && (
              <span className="text-[10px] text-muted font-medium whitespace-nowrap bg-surface-elevated/40 border border-border/40 px-3 py-1.5 rounded-lg select-none">
                {filteredSongs.length} of {playlist.songs.length} found
              </span>
            )}
          </div>
        )}

        {playlist.songs.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border/60 rounded-xl bg-surface/20 space-y-2">
            <Music className="w-8 h-8 text-muted mx-auto" />
            <p className="font-editorial text-lg text-text">This folder is empty</p>
            <p className="text-xs text-muted">Use search to find and add tracks into this curation.</p>
          </div>
        ) : filteredSongs.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border/60 rounded-xl bg-surface/20 space-y-2">
            <Search className="w-8 h-8 text-muted mx-auto" />
            <p className="font-editorial text-lg text-text">No matching tracks found</p>
            <p className="text-xs text-muted">Try typing a different song title or artist query.</p>
          </div>
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="hidden md:block overflow-hidden rounded-xl border border-border/60 bg-surface/20">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border/40 text-[10px] uppercase tracking-wider text-muted font-semibold bg-surface/30">
                    <th className="py-3 px-4 w-12 text-center">#</th>
                    <th className="py-3 px-4">Title</th>
                    <th className="py-3 px-4">Artist</th>
                    <th className="py-3 px-4 w-16 text-center">
                      <Clock className="w-3.5 h-3.5 mx-auto" />
                    </th>
                    <th className="py-3 px-4 w-28 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {filteredSongs.map((song, index) => {
                    const originalIndex = playlist.songs.indexOf(song);
                    return (
                      <tr key={index} className="hover:bg-surface/50 group transition">
                        <td className="py-3.5 px-4 text-center text-muted font-medium font-sans">
                          {index + 1}
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-text">
                          <div className="flex items-center gap-3">
                            <SongArtwork song={song} className="w-8 h-8 rounded shadow flex-shrink-0" priority={index < 5} />
                            <span className="truncate max-w-[240px]">{song.title}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-muted font-medium truncate max-w-[180px]">
                          {song.artist}
                        </td>
                        <td className="py-3.5 px-4 text-center text-muted font-mono">
                          {Math.floor(song.duration / 60)}:{(song.duration % 60) < 10 ? "0" : ""}{song.duration % 60}
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <div className="flex items-center justify-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition">
                            <button
                              onClick={() => playSong(song, filteredSongs)}
                              className="p-1.5 hover:bg-surface-elevated text-primary rounded transition cursor-pointer"
                              title="Play song"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                            </button>
                            <button
                              onClick={() => triggerRadio(song.videoId)}
                              className={`p-1.5 rounded transition cursor-pointer ${isRadio ? "text-primary text-glow" : "hover:bg-surface-elevated text-muted hover:text-primary"}`}
                              title={isRadio ? "Radio active" : "Start Radio from this song"}
                            >
                              <Radio className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleLikeSong(song)}
                              className="p-1.5 hover:bg-surface-elevated text-muted hover:text-primary rounded transition cursor-pointer"
                              title="Like track"
                            >
                              <Heart className="w-3.5 h-3.5" />
                            </button>
                             {(() => {
                               const isInQueue = queue.some((item) => item.videoId === song.videoId);
                               return (
                                 <button
                                   onClick={() => !isInQueue && addToQueue(song)}
                                   className={`p-1.5 rounded transition ${isInQueue ? "text-muted/40 cursor-default" : "hover:bg-surface-elevated text-muted hover:text-text cursor-pointer"}`}
                                   title={isInQueue ? "Added to queue" : "Add to queue"}
                                 >
                                   {isInQueue ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                                 </button>
                               );
                             })()}
                            {isOwner && (
                              <button
                                onClick={() => handleRemoveTrack(originalIndex)}
                                className="p-1.5 hover:bg-primary/10 text-muted hover:text-primary rounded transition cursor-pointer"
                                title="Remove track"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile List View */}
            <div className="md:hidden space-y-2.5">
              {filteredSongs.map((song, index) => {
                const originalIndex = playlist.songs.indexOf(song);
                return (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 rounded-xl border border-border/40 bg-surface/20 hover:bg-surface/30 active:bg-surface-elevated/40 transition select-none"
                  >
                    {/* Tappable Area to Play Song */}
                    <div
                      onClick={() => playSong(song, filteredSongs)}
                      className="flex items-center gap-3 min-w-0 flex-grow cursor-pointer"
                    >
                      <div className="text-muted font-medium text-[11px] w-4 text-center">
                        {index + 1}
                      </div>
                      <SongArtwork song={song} className="w-10 h-10 rounded-lg shadow-md flex-shrink-0" priority={index < 5} />
                      <div className="min-w-0 flex-grow">
                        <div className="text-xs font-semibold text-text truncate pr-2">{song.title}</div>
                        <div className="text-[11px] text-muted truncate mt-0.5">{song.artist}</div>
                      </div>
                    </div>

                    {/* Right-aligned Actions & Duration */}
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <span className="text-[10px] text-muted font-mono hidden sm:inline mr-1">
                        {Math.floor(song.duration / 60)}:{(song.duration % 60) < 10 ? "0" : ""}{song.duration % 60}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => triggerRadio(song.videoId)}
                          className={`p-1.5 rounded-lg transition active:scale-95 cursor-pointer ${isRadio ? "text-primary text-glow" : "hover:bg-surface-elevated text-muted hover:text-primary"}`}
                          title={isRadio ? "Radio active" : "Start Radio from this song"}
                        >
                          <Radio className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleLikeSong(song)}
                          className="p-1.5 hover:bg-surface-elevated text-muted hover:text-primary rounded-lg transition active:scale-95 cursor-pointer"
                          title="Like track"
                        >
                          <Heart className="w-4 h-4" />
                        </button>
                        {(() => {
                          const isInQueue = queue.some((item) => item.videoId === song.videoId);
                          return (
                            <button
                              onClick={() => !isInQueue && addToQueue(song)}
                              className={`p-1.5 rounded-lg transition active:scale-95 ${isInQueue ? "text-muted/40 cursor-default" : "hover:bg-surface-elevated text-muted hover:text-text cursor-pointer"}`}
                              title={isInQueue ? "Added to queue" : "Add to queue"}
                            >
                              {isInQueue ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                            </button>
                          );
                        })()}
                        {isOwner && (
                          <button
                            onClick={() => handleRemoveTrack(originalIndex)}
                            className="p-1.5 hover:bg-primary/10 text-muted hover:text-primary rounded-lg transition active:scale-95 cursor-pointer"
                            title="Remove track"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Collaborator Management Modal */}
      {showCollabModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-surface border border-border/80 rounded-2xl p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border/20 pb-3">
              <h3 className="font-editorial text-base text-text font-bold">Manage Collaborators</h3>
              <button onClick={() => setShowCollabModal(false)} className="p-1 text-muted hover:text-text cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Current collaborators */}
            {(playlist as any).collaborators_profiles?.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold">Current Collaborators</span>
                {(playlist as any).collaborators_profiles.map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between p-2 bg-surface-elevated/30 rounded-lg">
                    <span className="text-xs text-text font-medium truncate">{c.displayName} (@{c.username})</span>
                    <button
                      onClick={async () => {
                        const res = await fetch(apiUrl(`/playlists/${encodeURIComponent(id)}/collaborators`), {
                          method: "POST",
                          headers: {"Content-Type": "application/json", "Authorization": `Bearer ${token}`},
                          body: JSON.stringify({ collaboratorId: c.id, action: "remove" })
                        });
                        if ((await res.json()).success) loadPlaylist();
                      }}
                      className="p-1 text-red-400 hover:text-red-300 cursor-pointer"
                      title="Remove collaborator"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add collaborator */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-muted font-semibold">Add Collaborator</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter user ID..."
                  value={collabUserId}
                  onChange={(e) => setCollabUserId(e.target.value)}
                  className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-xs text-text focus:outline-none focus:border-primary/50"
                />
                <button
                  onClick={handleManageCollab}
                  disabled={!collabUserId.trim()}
                  className="px-3 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary-hover transition cursor-pointer disabled:opacity-50"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[9px] text-muted italic">Enter the user&apos;s database ID to add them as a collaborator. They can add/remove songs.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
