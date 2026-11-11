"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, Headphones, Loader2, Pause, Play, Plus, Search, Trash2, Users } from "lucide-react";
import type { Song } from "@strumm/types";
import { authFetch, getDeviceId } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import { searchYouTube } from "web/lib/search";
import SongArtwork from "web/components/SongArtwork";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { ARTWORK_QUALITY_HIGH, ARTWORK_QUALITY_LOW } from "web/lib/media";
import { WebSocketClient } from "web/services/realtime/WebSocketClient";
import { EventDispatcher } from "web/services/realtime/EventDispatcher";
import { WS_CONNECTED } from "web/services/realtime/types";
import { RoomPeerSync } from "web/services/realtime/RoomPeerSync";
import { isNewRoomPlaybackCommand, isStaleRoomPlaybackSnapshot, type RoomPlaybackPhase } from "web/lib/room-playback";

type Listener = { id: string; displayName: string; avatar?: string };
type Room = {
  id: string;
  name: string;
  hostId: string;
  isHost: boolean;
  hostName: string;
  joinCode: string;
  listeners: Listener[];
  listenerCount: number;
  currentTrack: Song | null;
  playbackState: {
    playing: boolean;
    targetPlaying?: boolean;
    timestamp: number;
    updatedAt: string | null;
    startAt?: number | null;
    sequence?: number;
    phase?: RoomPlaybackPhase;
    serverNow?: number;
  };
  queue: Song[];
};

async function readResponse(response: Response) {
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    const error = new Error(json?.detail || json?.error || "Room request failed.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return json.data;
}

function playbackPosition(room: Room) {
  const state = room.playbackState;
  if (!state?.playing || !state.updatedAt) return state?.timestamp || 0;
  const updatedAt = state.updatedAt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(state.updatedAt)
    ? `${state.updatedAt}Z`
    : state.updatedAt;
  const clockOffsetMs = typeof state.serverNow === "number" ? state.serverNow - Date.now() : 0;
  const serverNow = Date.now() + clockOffsetMs;
  const anchor = typeof state.startAt === "number"
    ? state.startAt
    : updatedAt ? new Date(updatedAt).getTime() : serverNow;
  const elapsed = Math.max(0, (serverNow - anchor) / 1000);
  return (state.timestamp || 0) + elapsed;
}

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const token = useAuthStore((state) => state.token);
  const wsClient = WebSocketClient.getInstance();
  const dispatch = EventDispatcher.getInstance();
  const { currentSong, isPlaying, currentTime, seekCount, lastSeekTime, roomPlaybackCommand, playSong, applyRemoteState } = usePlayerStore();
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Song[]>([]);
  const [searching, setSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [startingTrackId, setStartingTrackId] = useState<string | null>(null);
  const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
  const [addingTrackId, setAddingTrackId] = useState<string | null>(null);
  const [playbackPending, setPlaybackPending] = useState(false);
  const isHost = !!room?.isHost;
  const isSyncingPlayback = room?.playbackState?.phase === "preparing"
    || (!!room && roomPlaybackCommand?.id.startsWith(`${room.id}:`) === true);
  const hasInitialSnapshotRef = useRef(false);
  const roomRef = useRef<Room | null>(null);
  const roomJoinedRef = useRef(false);
  const lastRoomSequenceRef = useRef(0);
  const lastPublishedTrackRef = useRef<string | null>(null);
  const lastPublishedPlayingRef = useRef<boolean | null>(null);
  const lastAppliedPlaybackSequenceRef = useRef<number>(-1);
  const lastAppliedPlaybackPhaseRef = useRef<RoomPlaybackPhase | null>(null);
  const peerSyncRef = useRef<RoomPeerSync | null>(null);

  useEffect(() => {
    usePlayerStore.setState({ isListeningRoomActive: true });
    return () => {
      usePlayerStore.setState({
        isListeningRoomActive: false,
        roomPlaybackCommand: null,
      });
    };
  }, [id]);

  useEffect(() => {
    hasInitialSnapshotRef.current = false;
    lastPublishedTrackRef.current = null;
    lastPublishedPlayingRef.current = null;
    setRoom(null);
    roomRef.current = null;
    roomJoinedRef.current = false;
    lastRoomSequenceRef.current = 0;
    lastAppliedPlaybackSequenceRef.current = -1;
    lastAppliedPlaybackPhaseRef.current = null;
    setLoading(true);
    setError("");
  }, [id]);

  const applyRoom = useCallback((next: Room) => {
    const incomingSequence = next.playbackState?.sequence || 0;
    const incomingPhase = next.playbackState?.phase || "committed";
    const lastAppliedSequence = lastAppliedPlaybackSequenceRef.current;
    const lastAppliedPhase = lastAppliedPlaybackPhaseRef.current;
    if (isStaleRoomPlaybackSnapshot(incomingSequence, incomingPhase, lastAppliedSequence, lastAppliedPhase)) {
      return;
    }

    roomRef.current = next;
    lastRoomSequenceRef.current = Math.max(lastRoomSequenceRef.current, incomingSequence);
    setRoom(next);
    lastPublishedPlayingRef.current = !!next.playbackState?.playing;
    const sharedQueue = next.currentTrack
      ? [next.currentTrack, ...(next.queue || []).filter((song) => song.videoId !== next.currentTrack?.videoId)]
      : (next.queue || []);

    if (next.currentTrack) {
      lastPublishedTrackRef.current = next.currentTrack.videoId;
      const isInitialSnapshot = !hasInitialSnapshotRef.current;
      const sequence = incomingSequence;
      const phase = incomingPhase;
      const isNewPlaybackCommand = isNewRoomPlaybackCommand(
        sequence,
        phase,
        lastAppliedPlaybackSequenceRef.current,
        lastAppliedPlaybackPhaseRef.current,
      );
      if (isNewPlaybackCommand || isInitialSnapshot) {
        lastAppliedPlaybackSequenceRef.current = Math.max(lastAppliedPlaybackSequenceRef.current, sequence);
        lastAppliedPlaybackPhaseRef.current = phase;
        const targetPlaying = next.playbackState?.targetPlaying ?? !!next.playbackState?.playing;
        const isPreparing = phase === "preparing";
        const isPlayingNow = isPreparing
          ? (targetPlaying ? false : usePlayerStore.getState().isPlaying)
          : !!next.playbackState?.playing;
        const currentPosition = playbackPosition(next);
        const commandTimestamp = isInitialSnapshot ? currentPosition : (next.playbackState?.timestamp || 0);
        const clockOffsetMs = typeof next.playbackState?.serverNow === "number"
          ? next.playbackState.serverNow - Date.now()
          : 0;
        const startAt = phase === "preparing"
          ? null
          : isInitialSnapshot
            ? Date.now() + clockOffsetMs
            : typeof next.playbackState?.startAt === "number" ? next.playbackState.startAt : null;
        applyRemoteState({
          currentSong: next.currentTrack,
          isPlaying: isPlayingNow,
          currentTime: currentPosition,
          queue: sharedQueue,
          currentIndex: 0,
          roomPlaybackCommand: {
            id: `${next.id}:${sequence}`,
            videoId: next.currentTrack.videoId,
            timestamp: commandTimestamp,
            playing: targetPlaying,
            phase: phase as "preparing" | "committed",
            startAt,
            sequence,
            clockOffsetMs,
          },
        });
      } else if (next.isHost) {
        usePlayerStore.getState().setQueue(sharedQueue);
      }
    } else if (!hasInitialSnapshotRef.current) {
      lastPublishedTrackRef.current = usePlayerStore.getState().currentSong?.videoId ?? null;
    } else if (next.isHost) {
      usePlayerStore.getState().setQueue(sharedQueue);
    }
    hasInitialSnapshotRef.current = true;
    setError("");
  }, [applyRemoteState]);

  const refresh = useCallback(async (heartbeat = false) => {
    if (!token) return;
    const endpoint = heartbeat ? `/social/rooms/${id}/heartbeat` : `/social/rooms/${id}`;
    const response = await authFetch(apiUrl(endpoint), heartbeat ? { method: "POST" } : {});
    const data = await readResponse(response);
    applyRoom(data);
  }, [applyRoom, id, token]);

  useEffect(() => {
    if (!room) return;
    const peerSync = new RoomPeerSync(id, getDeviceId(), !!room.isHost, (command) => {
      if (room.isHost) return;
      if (!command || !["playback", "seek"].includes(command.type) ||
          typeof command.executeAt !== "number" ||
          typeof command.timestamp !== "number" ||
          typeof command.playing !== "boolean" ||
          typeof command.sequence !== "number") return;
      const delay = Math.max(0, command.executeAt - Date.now());
      window.setTimeout(() => {
        const currentRoom = roomRef.current;
        if (!currentRoom?.currentTrack || command.sequence <= lastAppliedPlaybackSequenceRef.current) return;
        lastAppliedPlaybackSequenceRef.current = command.sequence;
        lastAppliedPlaybackPhaseRef.current = "committed";
        lastRoomSequenceRef.current = Math.max(lastRoomSequenceRef.current, command.sequence);
        const sharedQueue = [
          currentRoom.currentTrack,
          ...(currentRoom.queue || []).filter((song) => song.videoId !== currentRoom.currentTrack?.videoId),
        ];
        const updatedRoom = {
          ...currentRoom,
          playbackState: {
            ...currentRoom.playbackState,
            sequence: command.sequence,
            phase: "committed" as const,
            playing: command.playing,
            targetPlaying: command.playing,
            timestamp: command.timestamp,
            startAt: command.executeAt,
            updatedAt: new Date().toISOString(),
          },
        };
        roomRef.current = updatedRoom;
        setRoom(updatedRoom);
        const state = usePlayerStore.getState();
        state.setCurrentTime(command.timestamp);
        state.clearLastSeekTime();
        applyRemoteState({
          currentSong: state.currentSong ?? currentRoom.currentTrack,
          isPlaying: command.playing,
          currentTime: command.timestamp,
          queue: sharedQueue,
          currentIndex: 0,
          roomPlaybackCommand: {
            id: `${currentRoom.id}:${command.sequence}`,
            videoId: currentRoom.currentTrack.videoId,
            timestamp: command.timestamp,
            playing: command.playing,
            phase: "committed",
            startAt: command.executeAt,
            sequence: command.sequence,
            clockOffsetMs: 0,
          },
        });
      }, delay);
    });
    peerSyncRef.current = peerSync;
    return () => {
      peerSync.dispose();
      if (peerSyncRef.current === peerSync) peerSyncRef.current = null;
    };
  }, [applyRemoteState, id, room?.id, room?.isHost]);

  useEffect(() => {
    const subscribe = () => {
      if (roomJoinedRef.current) {
        wsClient.send("room:subscribe", { roomId: id, deviceId: getDeviceId() });
      }
    };
    const unsubscribeConnected = dispatch.on(WS_CONNECTED, subscribe);
    const unsubscribeRoom = dispatch.on("room:state", (payload) => {
      if (payload?.roomId !== id || !payload?.room) return;
      const current = roomRef.current;
      if (!current) return;
      const sequence = payload.room.playbackState?.sequence || 0;
      if (sequence && sequence < lastRoomSequenceRef.current) return;
      applyRoom({ ...payload.room, isHost: current.isHost });
    });
    const unsubscribeError = dispatch.on("room:error", (payload) => {
      if (payload?.roomId === id && payload?.message) setError(payload.message);
    });
    let barrierDisposed = false;
    const handlePlaybackReady = (event: Event) => {
      const detail = (event as CustomEvent<{ sequence: number; videoId: string }>).detail;
      if (!detail || roomRef.current?.currentTrack?.videoId !== detail.videoId) return;
      void (async () => {
        const readyResponse = await authFetch(apiUrl(`/social/rooms/${id}/playback/ready`), {
          method: "POST",
          body: JSON.stringify({ sequence: detail.sequence, deviceId: getDeviceId() }),
        });
        let latest = await readResponse(readyResponse) as Room;
        applyRoom(latest);
        if (latest.playbackState?.sequence !== detail.sequence || latest.playbackState?.phase === "committed") return;

        // WebSocket is the fast path, but a backgrounded/throttled tab can
        // receive its commit late. Poll only while this exact barrier is open
        // so the client schedules against the server deadline as soon as the
        // commit exists, without waiting for the regular 15-second fallback.
        const deadline = Date.now() + 20000;
        while (!barrierDisposed && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (barrierDisposed) return;
          const response = await authFetch(apiUrl(`/social/rooms/${id}`));
          latest = await readResponse(response) as Room;
          if (latest.playbackState?.sequence !== detail.sequence) return;
          if (latest.playbackState?.phase === "committed") {
            applyRoom(latest);
            return;
          }
        }
      })().catch((err) => {
        if (!barrierDisposed) setError(err instanceof Error ? err.message : "Could not synchronize playback.");
      });
    };
    window.addEventListener("strumm:room-playback-ready", handlePlaybackReady);
    if (roomJoinedRef.current && wsClient.isConnected) subscribe();
    return () => {
      barrierDisposed = true;
      window.removeEventListener("strumm:room-playback-ready", handlePlaybackReady);
      unsubscribeConnected();
      unsubscribeRoom();
      unsubscribeError();
      roomJoinedRef.current = false;
      wsClient.send("room:unsubscribe", { roomId: id });
    };
  }, [applyRoom, dispatch, id, wsClient]);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let snapshotTimer: ReturnType<typeof setInterval>;
    let heartbeatTimer: ReturnType<typeof setInterval>;
    let handleVisibility: (() => void) | undefined;

    const start = async () => {
      try {
        const joined = await authFetch(apiUrl(`/social/rooms/${id}/join`), { method: "POST" });
        await readResponse(joined);
        await refresh(true);
        if (stopped) return;
        roomJoinedRef.current = true;
        if (wsClient.isConnected) wsClient.send("room:subscribe", { roomId: id, deviceId: getDeviceId() });
        setLoading(false);
        handleVisibility = () => {
          if (document.visibilityState === "visible") {
            void refresh(true).catch((err) => {
              if (err.status === 404) setRoom(null);
              setError(err.message);
            });
          }
        };
        document.addEventListener("visibilitychange", handleVisibility);
        snapshotTimer = setInterval(() => {
          if (wsClient.isConnected) return;
          void refresh().catch((err) => {
            if (err.status === 404) setRoom(null);
            setError(err.message);
          });
        }, 15000);
        heartbeatTimer = setInterval(() => {
          void refresh(true).catch((err) => {
            if (err.status === 404) setRoom(null);
            setError(err.message);
          });
        }, 7000);
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : "Could not open this room.");
          setLoading(false);
        }
      }
    };

    void start();
    return () => {
      stopped = true;
      clearInterval(snapshotTimer);
      clearInterval(heartbeatTimer);
      if (handleVisibility) document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [id, refresh, token, wsClient]);

  const updatePlayback = useCallback(async (
    song: Song | null,
    playing: boolean,
    timestamp: number,
    options: { direct?: boolean; sequence?: number } = {},
  ) => {
    if (!isHost) return;
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/playback`), {
        method: "POST",
        body: JSON.stringify({
          song,
          playing,
          timestamp,
          deviceId: getDeviceId(),
          direct: options.direct === true,
          sequence: options.sequence,
        }),
      });
      const data = await readResponse(response);
      if (!options.direct) applyRoom(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback update failed.");
    }
  }, [applyRoom, id, isHost]);

  const publishPeerPlayback = useCallback((playing: boolean, timestamp: number) => {
    const peerSync = peerSyncRef.current;
    const currentRoom = roomRef.current;
    const currentTrack = currentRoom?.currentTrack;
    if (!isHost || !peerSync || peerSync.connectedPeers === 0 || !currentRoom || !currentTrack) return false;

    const sequence = Math.max(lastAppliedPlaybackSequenceRef.current, currentRoom.playbackState.sequence || 0) + 1;
    const executeAt = Date.now() + 500;
    lastAppliedPlaybackSequenceRef.current = sequence;
    lastAppliedPlaybackPhaseRef.current = "committed";
    lastRoomSequenceRef.current = Math.max(lastRoomSequenceRef.current, sequence);
    peerSync.broadcast({ type: "playback", sequence, playing, timestamp, executeAt });

    const updatedRoom = {
      ...currentRoom,
      playbackState: {
        ...currentRoom.playbackState,
        sequence,
        phase: "committed" as const,
        playing,
        targetPlaying: playing,
        timestamp,
        startAt: executeAt,
        updatedAt: new Date().toISOString(),
      },
    };
    roomRef.current = updatedRoom;
    setRoom(updatedRoom);
    applyRemoteState({
      currentSong: usePlayerStore.getState().currentSong ?? currentTrack,
      isPlaying: playing,
      currentTime: timestamp,
      queue: [currentTrack, ...(currentRoom.queue || []).filter((song) => song.videoId !== currentTrack.videoId)],
      currentIndex: 0,
      roomPlaybackCommand: {
        id: `${currentRoom.id}:${sequence}`,
        videoId: currentTrack.videoId,
        timestamp,
        playing,
        phase: "committed",
        startAt: executeAt,
        sequence,
        clockOffsetMs: 0,
      },
    });
    void updatePlayback(currentTrack, playing, timestamp, { direct: true, sequence });
    return true;
  }, [applyRemoteState, isHost, updatePlayback]);

  useEffect(() => {
    if (!hasInitialSnapshotRef.current || !isHost || !room || !currentSong) return;
    if (currentSong.videoId === lastPublishedTrackRef.current) return;
    lastPublishedTrackRef.current = currentSong.videoId;
    lastPublishedPlayingRef.current = isPlaying;
    void updatePlayback(currentSong, isPlaying, currentTime);
  }, [currentSong?.videoId, currentTime, isHost, isPlaying, room?.id, updatePlayback]);

  useEffect(() => {
    if (!hasInitialSnapshotRef.current || !isHost || !room?.currentTrack) return;
    if (lastPublishedPlayingRef.current === isPlaying) return;
    lastPublishedPlayingRef.current = isPlaying;
    const livePlayer = usePlayerStore.getState();
    const measuredPosition = livePlayer.playerRef?.getCurrentTime?.();
    const authoritativePosition = typeof measuredPosition === "number" && Number.isFinite(measuredPosition)
      ? measuredPosition
      : currentTime;
    if (publishPeerPlayback(isPlaying, authoritativePosition)) return;
    void updatePlayback(room.currentTrack, isPlaying, authoritativePosition);
  }, [currentTime, isHost, isPlaying, publishPeerPlayback, room?.currentTrack?.videoId, updatePlayback]);


  // Room commands use a prepare/commit barrier; no periodic seek corrections
  // are allowed during normal playback because they create audible gaps.

  const lastPeerSeekCountRef = useRef(seekCount);
  useEffect(() => {
    if (!isHost || !room?.currentTrack || seekCount === lastPeerSeekCountRef.current) {
      lastPeerSeekCountRef.current = seekCount;
      return;
    }
    lastPeerSeekCountRef.current = seekCount;
    const state = usePlayerStore.getState();
    const timestamp = typeof state.lastSeekTime === "number" ? state.lastSeekTime : state.currentTime;
    state.setCurrentTime(timestamp);
    state.clearLastSeekTime();
    const peerSync = peerSyncRef.current;
    if (peerSync && peerSync.connectedPeers > 0 && roomRef.current?.currentTrack) {
      const currentRoom = roomRef.current;
      const currentTrack = currentRoom.currentTrack;
      if (!currentTrack) return;
      const sequence = Math.max(lastAppliedPlaybackSequenceRef.current, currentRoom.playbackState.sequence || 0) + 1;
      const executeAt = Date.now() + 500;
      lastAppliedPlaybackSequenceRef.current = sequence;
      lastAppliedPlaybackPhaseRef.current = "committed";
      lastRoomSequenceRef.current = Math.max(lastRoomSequenceRef.current, sequence);
      peerSync.broadcast({ type: "seek", sequence, timestamp, playing: isPlaying, executeAt });
      const updatedRoom = {
        ...currentRoom,
        playbackState: {
          ...currentRoom.playbackState,
          sequence,
          phase: "committed" as const,
          playing: isPlaying,
          targetPlaying: isPlaying,
          timestamp,
          startAt: executeAt,
          updatedAt: new Date().toISOString(),
        },
      };
      roomRef.current = updatedRoom;
      setRoom(updatedRoom);
      applyRemoteState({
        currentSong: state.currentSong ?? currentTrack,
        isPlaying,
        currentTime: timestamp,
        queue: [currentTrack, ...(currentRoom.queue || []).filter((song) => song.videoId !== currentTrack?.videoId)],
        currentIndex: 0,
        roomPlaybackCommand: {
          id: `${currentRoom.id}:${sequence}`,
          videoId: currentTrack.videoId,
          timestamp,
          playing: isPlaying,
          phase: "committed",
          startAt: executeAt,
          sequence,
          clockOffsetMs: 0,
        },
      });
      void updatePlayback(currentTrack, isPlaying, timestamp, { direct: true, sequence });

    } else if (room?.currentTrack) {
      void updatePlayback(room.currentTrack, isPlaying, timestamp);
    }
  }, [applyRemoteState, isHost, isPlaying, lastSeekTime, room?.currentTrack?.videoId, seekCount, updatePlayback]);

  const startTrack = async (song: Song) => {
    if (isSyncingPlayback) return;
    lastPublishedTrackRef.current = song.videoId;
    lastPublishedPlayingRef.current = true;
    setStartingTrackId(song.videoId);
    try {
      playSong(song);
      await updatePlayback(song, true, 0);
    } finally {
      setStartingTrackId(null);
    }
  };

  const togglePlayback = async () => {
    if (!room?.currentTrack || !isHost || isSyncingPlayback) return;
    const nextPlaying = !isPlaying;
    const livePlayer = usePlayerStore.getState();
    const measuredPosition = livePlayer.playerRef?.getCurrentTime?.();
    const position = typeof measuredPosition === "number" && Number.isFinite(measuredPosition) &&
      (measuredPosition > 0 || livePlayer.currentTime <= 0)
      ? measuredPosition
      : livePlayer.currentTime;
    lastPublishedPlayingRef.current = nextPlaying;
    setPlaybackPending(true);
    try {
      if (publishPeerPlayback(nextPlaying, position)) return;
      await updatePlayback(room.currentTrack, nextPlaying, position);
    } finally {
      setPlaybackPending(false);
    }
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await searchYouTube({ query: query.trim(), type: "video" });
      setResults(data.songs.slice(0, 8));
    } catch {
      setError("Song search failed. Try again.");
    } finally {
      setSearching(false);
    }
  };

  const addToRoomQueue = async (song: Song) => {
    if (addingTrackId) return;
    setAddingTrackId(song.videoId);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/queue`), {
        method: "POST",
        body: JSON.stringify({ song }),
      });
      applyRoom(await readResponse(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the song.");
    } finally {
      setAddingTrackId(null);
    }
  };

  const removeFromQueue = async (song: Song) => {
    if (!isHost || removingTrackId) return;
    setRemovingTrackId(song.videoId);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/queue/${encodeURIComponent(song.videoId)}`), { method: "DELETE" });
      applyRoom(await readResponse(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the song.");
    } finally {
      setRemovingTrackId(null);
    }
  };

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/leave`), { method: "POST" });
      await readResponse(response);
      router.push("/rooms");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not leave the room.");
      setLeaving(false);
    }
  };

  const copyCode = async () => {
    if (!room?.joinCode) return;
    await navigator.clipboard.writeText(room.joinCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) return <main className="mx-auto max-w-5xl px-4 py-16 text-center"><Loader2 className="mx-auto animate-spin" /></main>;
  if (error && !room) return <main className="mx-auto max-w-3xl px-4 py-12"><p role="alert" className="mb-4 text-sm text-red-500">{error}</p><button onClick={() => router.push("/rooms")} className="rounded-xl border border-border px-4 py-2 text-sm">Back to rooms</button></main>;
  if (!room) return null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <button onClick={() => void leave()} disabled={leaving} aria-busy={leaving} className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:cursor-wait disabled:opacity-60">{leaving ? <Loader2 size={16} className="animate-spin" /> : <ArrowLeft size={16} />} {leaving ? "Leaving…" : "Leave room"}</button>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary"><Headphones size={14} /> Listening room</p>
          <h1 className="text-3xl font-bold">{room.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Hosted by {room.hostName}{isHost ? " · You are hosting" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void copyCode()} className="rounded-xl border border-border px-4 py-2 text-sm font-mono tracking-widest">{copied ? "Copied" : room.joinCode} <Copy className="ml-2 inline" size={13} /></button>
        </div>
      </header>

      {error && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">{error}</p>}

      <section className="mb-6 grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Now playing</p>
          {room.currentTrack ? (
            <div className="flex items-center gap-4">
              <SongArtwork song={room.currentTrack} quality={ARTWORK_QUALITY_HIGH} className="h-20 w-20 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{room.currentTrack.title}</p>
                <p className="truncate text-sm text-muted-foreground">{room.currentTrack.artist}</p>
                <p className="mt-2 text-xs text-muted-foreground">{isSyncingPlayback ? "Synchronizing devices…" : room.playbackState.playing ? "Playing" : "Paused"} · {room.listenerCount} listening</p>
              </div>
              {isHost && <button disabled={isSyncingPlayback || playbackPending} aria-busy={playbackPending || isSyncingPlayback} onClick={() => void togglePlayback()} className="rounded-full bg-primary p-3 text-primary-foreground disabled:opacity-50">{playbackPending || isSyncingPlayback ? <Loader2 size={18} className="animate-spin" /> : isPlaying ? <Pause size={18} /> : <Play size={18} />}</button>}
            </div>
          ) : <p className="py-8 text-center text-sm text-muted-foreground">The host hasn’t started a track yet.</p>}
          {!isHost && <p className="mt-4 text-xs text-muted-foreground">The host controls playback for everyone.</p>}
        </div>
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Listeners</p>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold"><Users size={15} /> {room.listenerCount}</span>
          </div>
          <div className="space-y-3">
            {room.listeners.map((listener) => (
              <div key={listener.id} className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{listener.displayName.slice(0, 1).toUpperCase()}</div>
                <span className="min-w-0 flex-1 truncate text-sm">{listener.displayName}</span>
                {listener.id === room.hostId && <span className="text-[10px] uppercase tracking-wider text-primary">Host</span>}
              </div>
            ))}
            {!room.listeners.length && <p className="text-sm text-muted-foreground">Connecting…</p>}
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">Add music</h2>
          <form onSubmit={search} className="flex gap-2">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs or artists" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary" />
            <button disabled={searching || !query.trim()} className="rounded-xl bg-primary px-3 text-primary-foreground disabled:opacity-50">{searching ? <Loader2 className="animate-spin" size={17} /> : <Search size={17} />}</button>
          </form>
          <div className="mt-4 space-y-3">
            {results.map((song) => (
              <div key={song.videoId} className="flex items-center gap-3">
                <SongArtwork song={song} quality={ARTWORK_QUALITY_LOW} className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{song.title}</p><p className="truncate text-xs text-muted-foreground">{song.artist}</p></div>
                <button onClick={() => void addToRoomQueue(song)} disabled={addingTrackId !== null} aria-busy={addingTrackId === song.videoId} aria-label={`Add ${song.title} to queue`} className="rounded-lg border border-border p-2 hover:bg-muted disabled:opacity-50">{addingTrackId === song.videoId ? <Loader2 className="animate-spin" size={15} /> : <Plus size={15} />}</button>
                {isHost && <button disabled={isSyncingPlayback || startingTrackId !== null} aria-busy={startingTrackId === song.videoId} onClick={() => void startTrack(song)} aria-label={`Play ${song.title} now`} title="Play now for everyone" className="rounded-lg border border-primary/40 bg-primary/5 p-2 text-primary hover:bg-primary/10 disabled:opacity-50">{startingTrackId === song.videoId ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}</button>}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 font-semibold">Shared queue <span className="ml-1 text-xs font-normal text-muted-foreground">{room.queue.length}</span></h2>
          <div className="space-y-3">
            {room.queue.map((song) => (
              <div key={song.videoId} className="flex items-center gap-3">
                <SongArtwork song={song} quality={ARTWORK_QUALITY_LOW} className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{song.title}</p><p className="truncate text-xs text-muted-foreground">{song.artist}</p></div>
                {isHost && <button disabled={isSyncingPlayback || startingTrackId !== null} aria-busy={startingTrackId === song.videoId} onClick={() => void startTrack(song)} aria-label={`Play ${song.title} now`} title="Play now for everyone" className="rounded-lg border border-primary/40 bg-primary/5 p-2 text-primary hover:bg-primary/10 disabled:opacity-50">{startingTrackId === song.videoId ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}</button>}
                {isHost && <button onClick={() => void removeFromQueue(song)} disabled={removingTrackId !== null} aria-busy={removingTrackId === song.videoId} aria-label={`Remove ${song.title}`} className="rounded-lg border border-border p-2 text-muted-foreground hover:text-red-500 disabled:opacity-50">{removingTrackId === song.videoId ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}</button>}
              </div>
            ))}
            {!room.queue.length && <p className="py-8 text-center text-sm text-muted-foreground">The queue is empty. Add a song to get started.</p>}
          </div>
        </div>
      </section>
    </main>
  );
}
