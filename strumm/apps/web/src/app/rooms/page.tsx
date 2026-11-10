"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Headphones, Plus, Radio, Users } from "lucide-react";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import { useAuthStore } from "web/store/useAuthStore";

type Room = {
  id: string;
  name: string;
  hostName: string;
  joinCode: string;
  listenerCount: number;
  currentTrack?: { title?: string; artist?: string } | null;
};

async function readResponse(response: Response) {
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(json?.detail || json?.error || "Something went wrong.");
  }
  return json.data;
}

export default function RoomsPage() {
  const router = useRouter();
  const token = useAuthStore((state) => state.token);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadRooms = useCallback(async () => {
    if (!token) return;
    try {
      const response = await authFetch(apiUrl("/social/rooms"));
      setRooms(await readResponse(response));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load rooms.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const createRoom = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(apiUrl("/social/rooms"), {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      const room = await readResponse(response);
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the room.");
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (code.trim().length < 6 || busy) return;
    setBusy(true);
    setError("");
    try {
      const lookup = await authFetch(apiUrl(`/social/rooms/by-code/${encodeURIComponent(code.trim())}`));
      const room = await readResponse(lookup);
      const joined = await authFetch(apiUrl(`/social/rooms/${room.id}/join`), {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      await readResponse(joined);
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that room.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 md:px-6">
      <header className="mb-8">
        <div className="mb-3 flex items-center gap-2 text-sm text-primary">
          <Radio size={16} />
          <span className="font-semibold uppercase tracking-[0.2em]">Listen together</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Rooms</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Start a listening room, invite friends with a code, and share the same music queue.
        </p>
      </header>

      <section className="mb-8 grid gap-4 md:grid-cols-2">
        <form onSubmit={createRoom} className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-3 text-primary"><Plus size={20} /></span>
            <div>
              <h2 className="font-semibold">Create a room</h2>
              <p className="text-xs text-muted-foreground">You’ll be the host.</p>
            </div>
          </div>
          <label className="mb-2 block text-xs font-medium text-muted-foreground" htmlFor="room-name">Room name</label>
          <input id="room-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Friday night listening" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
          <button disabled={busy || !name.trim()} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            <Plus size={16} /> {busy ? "Working…" : "Create room"}
          </button>
        </form>

        <form onSubmit={joinByCode} className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-3 text-primary"><Headphones size={20} /></span>
            <div>
              <h2 className="font-semibold">Join with a code</h2>
              <p className="text-xs text-muted-foreground">Enter the six-character room code.</p>
            </div>
          </div>
          <label className="mb-2 block text-xs font-medium text-muted-foreground" htmlFor="room-code">Room code</label>
          <input id="room-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="ABC123" maxLength={6} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-primary" />
          <button disabled={busy || code.length !== 6} className="mt-3 h-11 w-full rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50">
            {busy ? "Joining…" : "Join room"}
          </button>
        </form>
      </section>

      {error && <p role="alert" className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</p>}

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your rooms</h2>
          <button onClick={() => void loadRooms()} className="text-xs font-medium text-muted-foreground hover:text-foreground">Refresh</button>
        </div>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2"><div className="h-28 animate-pulse rounded-2xl bg-muted" /><div className="h-28 animate-pulse rounded-2xl bg-muted" /></div>
        ) : rooms.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {rooms.map((room) => (
              <button key={room.id} onClick={() => router.push(`/rooms/${room.id}`)} className="rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/50 hover:bg-muted/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{room.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Hosted by {room.hostName}</p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-500"><Users size={13} /> {room.listenerCount}</span>
                </div>
                <p className="mt-4 truncate text-xs text-muted-foreground">{room.currentTrack?.title || "Nothing playing yet"}</p>
                <p className="mt-2 font-mono text-[11px] tracking-widest text-muted-foreground">{room.joinCode}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
            <Radio className="mx-auto mb-3 text-muted-foreground" size={26} />
            <p className="font-medium">No rooms yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Create one or join a friend using their code.</p>
          </div>
        )}
      </section>
    </main>
  );
}
