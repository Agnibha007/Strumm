"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { apiUrl } from "web/lib/api";
import { Radio, Users, Plus, Loader2, ArrowRight, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Room {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  members: string[];
  currentTrack?: {
    title: string;
    artist: string;
  } | null;
  visibility: string;
}

export default function RoomsPage() {
  const { token } = useAuthStore();
  const router = useRouter();
  
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomVisibility, setNewRoomVisibility] = useState<"public" | "circle">("public");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRooms = async () => {
    if (!token) return;
    try {
      const response = await fetch(apiUrl("/social/rooms"), {
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

  useEffect(() => {
    if (token) {
      fetchRooms();
    }
  }, [token]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim() || !token) return;
    
    setCreating(true);
    try {
      const response = await fetch(apiUrl("/social/rooms"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          name: newRoomName,
          visibility: newRoomVisibility
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
      setCreateOpen(false);
      setNewRoomName("");
    }
  };

  if (!token) {
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

  return (
    <div className="max-w-6xl mx-auto space-y-10 pb-12 w-full px-4 md:px-0 min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-start min-w-0">
        <div className="min-w-0">
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Strumm Rooms
          </span>
          <h2 className="text-3xl sm:text-4xl font-editorial text-text tracking-tight font-bold mt-1">
            Shared Listening Spaces
          </h2>
          <p className="text-sm text-muted mt-2 max-w-xl line-clamp-2">
            Rooms sync playback events (tracks, timestamps, and play states) on your own player. Toggle voice channels for WebRTC voice communication.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="p-2.5 bg-primary text-white hover:bg-primary-hover transition rounded-xl flex items-center gap-2 text-xs font-semibold flex-shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Room
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className="p-16 border border-dashed border-border/60 rounded-2xl text-center bg-surface/20 space-y-3">
          <Radio className="w-8 h-8 text-muted mx-auto opacity-70 animate-pulse" />
          <h4 className="font-editorial text-base text-text font-bold">No active rooms found</h4>
          <p className="text-xs text-muted max-w-xs mx-auto">
            Be the first to open a shared listening room and invite Circle friends.
          </p>
          <button
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 bg-primary/10 border border-primary/20 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition mt-3"
          >
            Create first Room
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 min-w-0">
          {rooms.map((room) => (
            <Link href={`/rooms/${room.id}`} key={room.id}>
              <span className="block p-5 bg-surface/30 hover:bg-surface-elevated/40 border border-border/60 rounded-2xl cursor-pointer transition min-w-0 relative overflow-hidden group">
                <div className="flex items-center justify-between mb-3 min-w-0">
                  <h4 className="text-base font-editorial font-bold text-text truncate max-w-[80%]">
                    {room.name}
                  </h4>
                  <ArrowRight className="w-4 h-4 text-muted group-hover:text-primary transition flex-shrink-0" />
                </div>
                
                <div className="flex items-center gap-2 text-xs text-muted/80 mb-4 min-w-0">
                  <User className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Hosted by {room.hostName}</span>
                </div>

                {room.currentTrack ? (
                  <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg flex flex-col gap-1 min-w-0 mb-4">
                    <span className="text-[9px] uppercase tracking-wider text-primary font-bold">Currently Playing</span>
                    <span className="text-xs font-semibold text-text truncate leading-snug">{room.currentTrack.title}</span>
                    <span className="text-[10px] text-muted truncate">{room.currentTrack.artist}</span>
                  </div>
                ) : (
                  <div className="text-[10px] text-muted italic p-2.5 border border-border/10 rounded-lg bg-surface-elevated/20 truncate mb-4">
                    No song loaded
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-border/20 pt-4 text-[10px] uppercase font-semibold text-muted tracking-wider">
                  <span className="flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {room.members.length} listening
                  </span>
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {room.visibility}
                  </span>
                </div>
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Create Room Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface border border-border/85 rounded-2xl p-6 max-w-sm w-full shadow-2xl space-y-5">
            <h3 className="font-editorial text-xl font-bold text-text border-b border-border/20 pb-3">Create Shared Room</h3>
            <form onSubmit={handleCreateRoom} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-text">Room Name</label>
                <input
                  type="text"
                  placeholder="e.g. Late Night Chill 🌙"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  className="w-full bg-background border border-border/60 rounded-xl px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-text">Visibility</label>
                <select
                  value={newRoomVisibility}
                  onChange={(e) => setNewRoomVisibility(e.target.value as any)}
                  className="w-full bg-background border border-border/60 rounded-xl px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50"
                >
                  <option value="public">Public Lobby</option>
                  <option value="circle">Circle Members Only</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="flex-1 py-2 px-4 border border-border/80 hover:bg-surface-elevated text-text text-xs font-semibold rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newRoomName.trim()}
                  className="flex-1 py-2 px-4 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition disabled:opacity-50"
                >
                  {creating ? "Opening..." : "Open Room"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
