"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import {
  ArrowRight,
  Check,
  Crown,
  Headphones,
  KeyRound,
  Loader2,
  Music,
  Plus,
  Radio,
  Search,
  Signal,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SongArtwork from "web/components/SongArtwork";
import { ARTWORK_QUALITY_LOW } from "web/lib/media";

interface RoomTrack {
  videoId: string;
  title: string;
  artist?: string;
  thumbnail: string;
}

interface Room {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  members: string[];
  currentTrack?: RoomTrack | null;
  visibility: string;
  joinCode?: string | null;
}

interface ResolvedByCode {
  id: string;
  name: string;
  hostName: string;
  memberCount: number;
}

function LivePill({ listeners }: { listeners: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 px-2.5 py-1 text-[9px] uppercase tracking-wider font-bold">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
      </span>
      Live · {listeners}
    </span>
  );
}

export default function RoomsPage() {
  const { token, user } = useAuthStore();
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [suggestions, setSuggestions] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setError] = useState<string | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Room[]>([]);
  const [searching, setSearching] = useState(false);

  // Start-a-Room sheet
  const [startOpen, setStartOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [roomVisibility, setRoomVisibility] = useState<"public" | "circle">("public");
  const [creating, setCreating] = useState(false);

  // Enter-with-code sheet
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<ResolvedByCode | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const joinedRoomIds = useMemo(() => {
    if (!user) return new Set<string>();
    return new Set(rooms.filter((r) => r.hostId === user.id || r.members.includes(user.id)).map((r) => r.id));
  }, [rooms, user]);

  const fetchRooms = async () => {
    if (!user) return;
    try {
      const response = await authFetch(apiUrl("/social/rooms"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setRooms(json.data || []);
      }
    } catch (e) {
      setError("Failed to connect to Room server.");
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestions = async () => {
    if (!user) return;
    try {
      const response = await authFetch(apiUrl("/social/rooms/suggestions"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setSuggestions(json.data || []);
      }
    } catch (e) {
      // Suggestions are non-critical — swallow failures quietly.
    }
  };

  // Stale-guard: ignore responses from searches that were superseded (slow
  // network could otherwise flash outdated results into the results list).
  const handleSearch = async (query: string) => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/search?q=${encodeURIComponent(q)}`), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setSearchResults(json.data || []);
      }
    } catch (e) {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchRooms();
      fetchSuggestions();
    }
  }, [user]);

  const openStartSheet = () => {
    setStartOpen(true);
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim() || !user) return;

    setCreating(true);
    try {
      const response = await authFetch(apiUrl("/social/rooms"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name: roomName,
          visibility: roomVisibility
        })
      });
      const json = await response.json();
      if (json.success && json.data?.id) {
        router.push(`/rooms/${json.data.id}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setCreating(false);
      setStartOpen(false);
      setRoomName("");
    }
  };

  const openCodeSheet = () => {
    setCodeInput("");
    setResolved(null);
    setCodeError(null);
    setCodeOpen(true);
  };

  const handleResolveCode = async () => {
    const code = codeInput.trim().toUpperCase().replace(/\s/g, "");
    if (!code) return;
    setResolving(true);
    setResolved(null);
    setCodeError(null);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/by-code/${encodeURIComponent(code)}`), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setResolved(json.data);
      } else {
        setCodeError(json.error || json.detail || "No room found for that code.");
      }
    } catch (e) {
      setCodeError("Unable to reach the room server.");
    } finally {
      setResolving(false);
    }
  };

  const handleCopyCode = (code: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
  };

  if (!user) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-6 gap-4">
        <Radio className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Rooms Locked</h3>
        <p className="text-sm text-muted">Sign in to join or create a shared Strumm Room.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Opening Rooms Lobby...</span>
      </div>
    );
  }

  const renderRoomCard = (room: Room, extraLabel?: string) => (
    <Link href={`/rooms/${room.id}`} key={room.id}>
      <span className="block relative overflow-hidden group h-full rounded-2xl bg-surface/40 border border-border/60 hover:border-primary/40 transition min-w-0 cursor-pointer soft-enter">
        {/* Full-bleed blurred artwork backdrop */}
        {room.currentTrack ? (
          <div className="absolute inset-0">
            <SongArtwork
              song={room.currentTrack}
              className="w-full h-full blur-2xl scale-125 opacity-40"
              quality={ARTWORK_QUALITY_LOW}
            />
          </div>
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-surface-elevated/80 via-surface/80 to-background" />
        )}
        {/* Legibility gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/30 to-transparent" />

        <div className="relative flex flex-col h-full p-5 min-w-0">
          <div className="flex items-start justify-between gap-3 min-w-0">
            {/* Artwork thumb */}
            <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden ring-1 ring-border/60 shadow-xl">
              <SongArtwork
                song={room.currentTrack}
                className="w-full h-full"
                quality={ARTWORK_QUALITY_LOW}
                iconClassName="w-5 h-5"
              />
            </div>
            <LivePill listeners={room.members.length} />
          </div>

          <div className="mt-4 min-w-0">
            <h4 className="text-lg font-editorial font-bold text-text truncate leading-snug">
              {room.name}
              {extraLabel && (
                <span className="ml-2 text-[9px] font-sans uppercase tracking-widest text-accent align-middle">
                  {extraLabel}
                </span>
              )}
            </h4>
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted min-w-0">
              <Crown className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="truncate">{room.hostName}</span>
            </div>
          </div>

          {/* Currently playing strip */}
          <div className="mt-4 p-3 rounded-xl bg-background/50 backdrop-blur-sm border border-white/5 min-w-0">
            {room.currentTrack ? (
              <div className="flex items-center gap-2 min-w-0">
                <Signal className="w-3.5 h-3.5 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-[9px] uppercase tracking-wider text-primary font-bold">Now Synced</p>
                  <p className="text-xs font-semibold text-text truncate leading-snug">{room.currentTrack.title}</p>
                  <p className="text-[10px] text-muted truncate">{room.currentTrack.artist || "—"}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[10px] text-muted italic min-w-0">
                <Music className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Waiting for the host to drop the first track...</span>
              </div>
            )}
          </div>

          {/* Footer meta */}
          <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider font-semibold text-muted">
            <span className="flex items-center gap-1.5 min-w-0">
              <Users className="w-3.5 h-3.5 shrink-0" />
              <span>{room.members.length} listening</span>
            </span>
            {room.joinCode && (
              <span
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCopyCode(room.joinCode!); }}
                title="Copy invite code"
                className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 text-primary px-1.5 py-0.5 font-mono text-[10px] tracking-wider hover:bg-primary/20 transition cursor-pointer"
              >
                {room.joinCode}
                <Check className="w-2.5 h-2.5" />
              </span>
            )}
            <span className="shrink-0 capitalize">
              {room.visibility === "public" ? "Public" : "Circle"}
            </span>
          </div>
        </div>
      </span>
    </Link>
  );

  return (
    <div className="max-w-6xl space-y-10 pb-12 w-full px-4 md:px-0 min-w-0 overflow-hidden soft-enter">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-border/50 bg-gradient-to-br from-surface-elevated/60 via-surface/40 to-background p-8 md:p-12">
        <div className="absolute -top-32 -right-24 w-80 h-80 rounded-full bg-primary/15 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-40 -left-24 w-96 h-96 rounded-full bg-accent/10 blur-3xl pointer-events-none" />
        <div className="relative max-w-2xl space-y-6">
          <span className="inline-flex items-center gap-2 text-[10px] tracking-widest uppercase font-bold text-primary">
            <Radio className="w-4 h-4" />
            Strumm Rooms
          </span>
          <h2 className="font-editorial text-4xl sm:text-5xl text-text tracking-tight font-bold leading-[1.05]">
            One song.
            <br />
            <span className="text-primary">Everyone&apos;s listening.</span>
          </h2>
          <p className="text-sm text-muted max-w-xl leading-relaxed">
            Rooms sync playback, queue, and voice on your own player — start a space, drop a
            track, and share the code with your Circle. No one misses a beat.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={openStartSheet}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-primary text-white hover:bg-primary-hover text-xs font-bold uppercase tracking-wider transition shadow-lg shadow-primary/20 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Start a Room
            </button>
            <button
              onClick={openCodeSheet}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-surface border border-border/70 hover:bg-surface-elevated text-text text-xs font-bold uppercase tracking-wider transition cursor-pointer"
            >
              <KeyRound className="w-4 h-4 text-primary" />
              Enter with Code
            </button>
          </div>
        </div>
      </section>

      {/* Find + Discover */}
      <section className="space-y-5 min-w-0">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <h3 className="font-editorial text-2xl font-bold text-text truncate min-w-0">
            {searchQuery.trim() ? `Results for "${searchQuery.trim()}"` : "Live Rooms"}
          </h3>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); handleSearch(searchQuery); }}
          className="flex gap-2 w-full max-w-md min-w-0"
        >
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-surface/30 border border-border/60 focus-within:border-primary/50 rounded-xl px-3 transition">
            <Search className="w-4 h-4 text-muted shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch(searchQuery)}
              placeholder="Find a room..."
              className="flex-1 min-w-0 w-full bg-transparent py-2.5 text-sm text-text focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="px-4 py-2.5 bg-primary text-white text-xs font-semibold rounded-xl hover:bg-primary-hover transition cursor-pointer flex items-center gap-1.5 disabled:opacity-60 shrink-0"
          >
            {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Search
          </button>
        </form>

        {searchQuery.trim() && searchResults.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 min-w-0">
            {searchResults.map((room) => renderRoomCard(room))}
          </div>
        )}

        {!searchQuery.trim() && rooms.length === 0 && (
          <div className="p-16 border border-dashed border-border/60 rounded-2xl text-center bg-surface/20 space-y-3">
            <Radio className="w-8 h-8 text-muted mx-auto opacity-70 animate-pulse" />
            <h4 className="font-editorial text-base text-text font-bold">No live rooms right now</h4>
            <p className="text-xs text-muted max-w-xs mx-auto">
              Be the first to open a shared listening room and invite Circle friends.
            </p>
            <button
              onClick={openStartSheet}
              className="px-4 py-2 bg-primary/10 border border-primary/20 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition mt-3"
            >
              Start the first Room
            </button>
          </div>
        )}

        {!searchQuery.trim() && rooms.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 min-w-0">
            {rooms.map((room) => renderRoomCard(room, room.hostId === user.id ? "Hosting" : joinedRoomIds.has(room.id) ? "Joined" : undefined))}
          </div>
        )}

        {searchQuery.trim() && !searching && searchResults.length === 0 && (
          <p className="text-xs text-muted italic">No rooms match that search.</p>
        )}
      </section>

      {/* Suggested rooms (fresh public rooms you aren't hosting/member of) */}
      {!searchQuery.trim() && suggestions.length > 0 && (
        <section className="space-y-4 min-w-0 border-t border-border/20 pt-8">
          <div className="flex items-center gap-2">
            <Headphones className="w-4 h-4 text-primary" />
            <h3 className="font-editorial text-xl font-bold text-text">Discover Rooms</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 min-w-0">
            {suggestions.map((room) => renderRoomCard(room))}
          </div>
        </section>
      )}

      {/* Start a Room — bottom sheet */}
      {startOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setStartOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-sm bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-5 soft-enter max-h-[85vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between min-w-0">
              <div className="min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Start a Room</span>
                <h3 className="font-editorial text-xl font-bold text-text mt-0.5">Name your listening party</h3>
              </div>
              <button
                onClick={() => setStartOpen(false)}
                className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateRoom} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-text">Room Name</label>
                <input
                  type="text"
                  placeholder="e.g. Late Night Chill 🌙"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full bg-background border border-border/60 rounded-xl px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50"
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-text">Who can join?</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRoomVisibility("public")}
                    className={`rounded-xl px-4 py-2.5 text-xs font-semibold border transition cursor-pointer flex flex-col items-start gap-0.5 ${
                      roomVisibility === "public"
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "bg-background border-border/60 text-muted hover:text-text"
                    }`}
                  >
                    Public
                    <span className={`text-[9px] font-normal ${roomVisibility === "public" ? "text-primary/70" : "text-muted/60"}`}>
                      Anyone in the lobby
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRoomVisibility("circle")}
                    className={`rounded-xl px-4 py-2.5 text-xs font-semibold border transition cursor-pointer flex flex-col items-start gap-0.5 ${
                      roomVisibility === "circle"
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "bg-background border-border/60 text-muted hover:text-text"
                    }`}
                  >
                    Circle
                    <span className={`text-[9px] font-normal ${roomVisibility === "circle" ? "text-primary/70" : "text-muted/60"}`}>
                      Friends + invitees
                    </span>
                  </button>
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setStartOpen(false)}
                  className="flex-1 py-2 px-4 border border-border/80 hover:bg-surface-elevated text-text text-xs font-semibold rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !roomName.trim()}
                  className="flex-1 py-2 px-4 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition disabled:opacity-50 cursor-pointer inline-flex items-center justify-center gap-2"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                  {creating ? "Opening..." : "Open Room"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Enter with Code — bottom sheet */}
      {codeOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setCodeOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-sm bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-5 soft-enter max-h-[85vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between min-w-0">
              <div className="min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Join a Room</span>
                <h3 className="font-editorial text-xl font-bold text-text mt-0.5">Enter invite code</h3>
              </div>
              <button
                onClick={() => setCodeOpen(false)}
                className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <input
                type="text"
                placeholder="e.g. K7JX2M"
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value.toUpperCase());
                  setResolved(null);
                  setCodeError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && handleResolveCode()}
                className="w-full bg-background border border-border/60 rounded-xl px-4 py-3 text-center font-mono text-lg tracking-[0.3em] text-text focus:outline-none focus:border-primary/50"
                autoFocus
                maxLength={8}
              />
              <button
                onClick={handleResolveCode}
                disabled={resolving || !codeInput.trim()}
                className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition disabled:opacity-50 cursor-pointer inline-flex items-center justify-center gap-2"
              >
                {resolving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                {resolving ? "Looking up..." : "Find Room"}
              </button>

              {codeError && (
                <p className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 p-2.5 rounded-lg">
                  {codeError}
                </p>
              )}

              {resolved && (
                <div className="flex items-center justify-between gap-3 p-3 bg-surface-elevated/40 border border-primary/25 rounded-xl">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-text truncate">{resolved.name}</p>
                    <p className="text-[10px] text-muted truncate mt-0.5">
                      {resolved.hostName} · {resolved.memberCount} listening
                    </p>
                  </div>
                  <button
                    onClick={() => router.push(`/rooms/${resolved.id}`)}
                    className="px-3 py-1.5 bg-primary text-white text-[10px] font-bold rounded-lg hover:bg-primary-hover transition cursor-pointer shrink-0"
                  >
                    Join
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}