"use client";

import { useEffect, useRef, useState, use } from "react";
import { isAccessTokenExpiredOrAbsent, useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { authFetch } from "web/lib/auth-client";
import { apiUrl, API_ORIGIN } from "web/lib/api";
import { searchYouTube } from "web/lib/search";
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  KeyRound,
  ListMusic,
  Loader2,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import SongArtwork from "web/components/SongArtwork";
import { ARTWORK_QUALITY_HIGH, ARTWORK_QUALITY_LOW } from "web/lib/media";
import { useRouter } from "next/navigation";
import { useNotificationStore } from "web/store/useNotificationStore";

interface RoomDetails {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  members: string[];
  membersProfiles: Array<{
    id: string;
    displayName: string;
    avatar?: string;
  }>;
  currentTrack?: any;
  playbackState?: {
    playing: boolean;
    timestamp: number;
    updatedAt: string;
  };
  queue: any[];
  visibility: string;
  controllers?: string[];
  joinCode?: string;
}

type RailTab = "queue" | "chat" | "people";

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function RoomDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { show } = useNotificationStore();

  const { token, user } = useAuthStore();
  const { currentSong, isPlaying, currentTime, setCurrentTime, playSong, setPlaying, playerRef, addToQueue } = usePlayerStore();

  const [room, setRoom] = useState<RoomDetails | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Track currently active members using WebSocket join/leave events
  const [activeMemberIds, setActiveMemberIds] = useState<Set<string>>(new Set());

  // WebSocket and WebRTC Refs
  const socketRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});

  // UI states
  const [railTab, setRailTab] = useState<RailTab>("queue");
  const [messages, setMessages] = useState<Array<{ sender: string; text: string }>>([]);
  const [inputText, setInputText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const isHost = room && user ? room.hostId === user.id : false;
  // Host OR an approved controller can drive playback (backend enforces too).
  const canControl = isHost || !!room?.controllers?.includes(user?.id ?? "");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestQuery, setSuggestQuery] = useState("");
  const [suggestResults, setSuggestResults] = useState<any[]>([]);
  const [searchingSongs, setSearchingSongs] = useState(false);
  const [addedToQueue, setAddedToQueue] = useState<Set<string>>(new Set());

  // Join code sheet
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [regeneratingCode, setRegeneratingCode] = useState(false);

  // Leave / delete sheet
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Invite flow (host only): pick a Circle friend to invite into the room.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [circleFriends, setCircleFriends] = useState<Array<{ id: string; displayName: string; username: string; avatar?: string }>>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [invitedMsg, setInvitedMsg] = useState<string | null>(null);

  // Kick flow (host only)
  const [kickingId, setKickingId] = useState<string | null>(null);

  const pendingCandidatesRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const voiceActiveRef = useRef(voiceActive);
  useEffect(() => {
    voiceActiveRef.current = voiceActive;
  }, [voiceActive]);

  const isHostRef = useRef(isHost);
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  const currentSongRef = useRef(currentSong);
  useEffect(() => {
    currentSongRef.current = currentSong;
  }, [currentSong]);

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch Room Info
  const fetchRoomInfo = async () => {
    if (!user) return;
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}`), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setRoom(json.data);
        setRoomError(null);
        // Initialize active members with all members from initial fetch
        // (will be updated in real-time via WebSocket). members is an array of
        // user-ID strings (not objects), so flatten both shapes defensively.
        setActiveMemberIds(new Set(
          (json.data.members || [])
            .map((m: any) => (typeof m === "string" ? m : m?.id))
            .filter(Boolean)
        ));
      } else {
        setRoomError(json.error || "Failed to load room.");
      }
    } catch (e) {
      console.error("Failed to load room details:", e);
      setRoomError("Failed to load room details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchRoomInfo();
    }
    // Cleanup: remove current user from active members when leaving room
    return () => {
      if (user?.id) {
        setActiveMemberIds(prev => {
          const next = new Set(prev);
          next.delete(user.id);
          return next;
        });
      }
    };
  }, [token, id, user?.id]);

  const cleanQueueEntry = (s: any) => s && typeof s === "object" && s.videoId ? s : null;

  const applySnapshot = (snap: any) => {
    setRoom(prev => ({
      ...(prev || {}),
      currentTrack: snap.currentTrack ?? prev?.currentTrack,
      playbackState: snap.playbackState ?? prev?.playbackState,
      queue: (snap.queue ?? prev?.queue ?? []).map(cleanQueueEntry).filter(Boolean),
      hostId: snap.hostId ?? prev?.hostId,
      hostName: snap.hostName ?? prev?.hostName,
      controllers: snap.controllers ?? prev?.controllers ?? [],
      visibility: snap.visibility ?? prev?.visibility,
      joinCode: snap.joinCode ?? prev?.joinCode,
      membersProfiles: snap.membersProfiles ?? prev?.membersProfiles ?? [],
      members: (snap.membersProfiles || []).map((m: any) => m.id),
    } as RoomDetails));

    // Non-hosts sync their local player to the room's live state on connect.
    if (!isHostRef.current && snap.currentTrack) {
      const track = snap.currentTrack;
      if (currentSongRef.current?.videoId !== track.videoId) {
        playSong(track, [track]);
      }
      setPlaying(!!snap.playbackState?.playing);
      const ts = snap.playbackState?.timestamp || 0;
      setCurrentTime(ts);
      if (playerRef?.seekTo) {
        playerRef.seekTo(ts);
      }
    }
  };

  // Keep the latest access token so WS (re)connects use a fresh credential
  // without tearing the socket down every time auth rotates it in the background.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Connect WebSocket (auto-reconnects with backoff + heartbeat so a dropped or
  // idle-killed socket recovers instead of leaving the room silently "offline").
  useEffect(() => {
    if (!user?.id || !room) return;

    let baseWs = API_ORIGIN.replace(/^http/, "ws");
    if (baseWs.endsWith("/")) {
      baseWs = baseWs.slice(0, -1);
    }
    // Token goes in the Sec-WebSocket-Protocol header (never in the URL) so it
    // can't leak into server access logs or Referer headers. The backend
    // accepts "authorization, <token>"; the query-param fallback stays for
    // older clients.
    const wsUrl = baseWs + `/social/rooms/${id}/ws`;

    let alive = true;
    let ws!: WebSocket;
    let reconnectDelay = 1000;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let lostToastShown = false;

    const scheduleReconnect = () => {
      if (!alive) return;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, Math.min(reconnectDelay, 30000));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    const connect = () => {
      if (!alive) return;
      const currentToken = tokenRef.current;
      if (!currentToken || isAccessTokenExpiredOrAbsent(currentToken)) {
        scheduleReconnect();
        return;
      }
      ws = new WebSocket(wsUrl, ["authorization", currentToken]);
      socketRef.current = ws;

      // Add current user to active members on connect (re-added on every retry)
      setActiveMemberIds(prev => new Set([...prev, user.id]));

      ws.onopen = () => {
        reconnectDelay = 1000;
      };

      ws.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { event: wsEvent, data: eventData } = payload;

        if (wsEvent === "room:state") {
          applySnapshot(eventData);
        }

      else if (wsEvent === "room:joined") {
        setMessages(prev => [...prev, { sender: "System", text: `${eventData.displayName || "A listener"} joined the room.` }]);
        fetchRoomInfo();
        // Track active member
        const newMemberId = eventData.userId;
        setActiveMemberIds(prev => new Set([...prev, newMemberId]));

        if (isHostRef.current && currentSongRef.current) {
          // Sync new member with host's current track state
          ws.send(JSON.stringify({
            event: "track:update",
            data: { song: currentSongRef.current }
          }));
          ws.send(JSON.stringify({
            event: isPlayingRef.current ? "play" : "pause",
            data: { timestamp: currentTimeRef.current }
          }));
        }

        // If voice is active, initiate WebRTC offer to the newly joined member
        if (voiceActiveRef.current && newMemberId !== user?.id) {
          const pc = createPeerConnection(newMemberId);
          pc.createOffer().then(offer => {
            pc.setLocalDescription(offer);
            sendSignal(newMemberId, { sdp: offer });
          });
        }
      }

      else if (wsEvent === "room:left") {
        setMessages(prev => [...prev, { sender: "System", text: `A listener left the room.` }]);
        fetchRoomInfo();
        // Track member leaving
        const leavingMemberId = eventData.userId;
        setActiveMemberIds(prev => {
          const next = new Set(prev);
          next.delete(leavingMemberId);
          return next;
        });
        // Remove WebRTC peer connection
        const peerId = eventData.userId;
        if (peerConnectionsRef.current[peerId]) {
          peerConnectionsRef.current[peerId].close();
          delete peerConnectionsRef.current[peerId];
        }
      }

      else if (wsEvent === "room:kicked") {
        if (eventData.userId === user?.id) {
          // I got kicked — head back to the lobby.
          show("You were removed from this room by the host.", "error");
          router.push("/rooms");
          return;
        }
        setMessages(prev => [...prev, { sender: "System", text: `${eventData.displayName || "A listener"} was removed from the room.` }]);
        setActiveMemberIds(prev => {
          const next = new Set(prev);
          next.delete(eventData.userId);
          return next;
        });
      }

      else if (wsEvent === "chat:message") {
        setMessages(prev => [...prev, { sender: eventData.senderName, text: eventData.text }]);
      }

      else if (wsEvent === "track:update") {
        if (!isHostRef.current && eventData.song) {
          playSong(eventData.song, [eventData.song]);
        }
        setRoom(prev => prev ? { ...prev, currentTrack: eventData.song } : null);
      }

      else if (wsEvent === "play") {
        if (!isHostRef.current) {
          setPlaying(true);
          setCurrentTime(eventData.timestamp);
          if (playerRef?.seekTo) {
            playerRef.seekTo(eventData.timestamp);
          }
        }
      }

      else if (wsEvent === "pause") {
        if (!isHostRef.current) {
          setPlaying(false);
        }
      }

      else if (wsEvent === "seek") {
        if (!isHostRef.current) {
          setCurrentTime(eventData.timestamp);
          if (playerRef?.seekTo) {
            playerRef.seekTo(eventData.timestamp);
          }
        }
      }

      else if (wsEvent === "queue:add") {
        const entry = cleanQueueEntry(eventData.song);
        if (!entry) return;
        addToQueue(entry);
        setRoom(prev => prev ? { ...prev, queue: [...(prev.queue || []), entry] } : null);
      }

      else if (wsEvent === "queue:removed") {
        setRoom(prev => prev
          ? { ...prev, queue: (prev.queue || []).filter((s) => s.videoId !== eventData.videoId) }
          : null);
      }

      else if (wsEvent === "queue:cleared") {
        setRoom(prev => prev ? { ...prev, queue: [] } : null);
      }

      else if (wsEvent === "control:denied") {
        show(eventData.reason || "You don't have permission to do that in this room.", "error");
      }

      else if (wsEvent === "room:host_transferred") {
        const newHostId = eventData.hostId;
        setMessages(prev => [...prev, {
          sender: "System",
          text: `${eventData.hostName || "Someone"} is now hosting the room.`,
        }]);
        setRoom(prev => prev ? {
          ...prev,
          hostId: newHostId,
          hostName: eventData.hostName || prev.hostName,
        } : null);
        if (newHostId === user?.id) {
          fetchRoomInfo();
        }
      }

      else if (wsEvent === "room:controllers_updated") {
        setRoom(prev => prev ? { ...prev, controllers: eventData.controllers || [] } : null);
      }

      else if (wsEvent === "room:deleted" || payload.type === "room_deleted") {
        router.push("/rooms");
      }

      else if (wsEvent === "signal") {
        const { from, signal } = eventData;
        // WebRTC Signaling Answer/Offer/Candidate Processing
        if (eventData.to === user.id) {
          await handleReceiveSignal(from, signal);
        }
      }
      } catch (err) {
        console.error("Failed to handle room message:", err);
      }
    };

    ws.onerror = () => {
      show("Room connection error — reconnecting…", "error");
    };

    ws.onclose = () => {
      socketRef.current = null;
      if (!alive) return;
      if (!lostToastShown) {
        show("Room connection lost — reconnecting…", "error");
        lostToastShown = true;
      }
      scheduleReconnect();
    };
    };

    heartbeatTimer = window.setInterval(() => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ event: "ping" }));
      }
    }, 25000);

    connect();

    return () => {
      alive = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      // Remove current user from active members on disconnect
      setActiveMemberIds(prev => {
        const next = new Set(prev);
        next.delete(user?.id);
        return next;
      });
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
      Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
    };
  }, [id, room?.id, user?.id]);

  // Host Action Broadcasters
  useEffect(() => {
    if (!canControl || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

    // Broadcast track update and update local room state for host
    if (currentSong) {
      const song = currentSong;
      socketRef.current.send(JSON.stringify({
        event: "track:update",
        data: { song }
      }));
      // Immediately reflect change in UI for host
      setRoom(prev => prev ? { ...prev, currentTrack: song } : null);
    }
  }, [currentSong?.videoId, canControl]);

  // Host Playback Sync Broadcaster
  const lastTimeRef = useRef(currentTime);
  const lastPlayingRef = useRef(isPlaying);

  useEffect(() => {
    if (!canControl || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

    // 1. Play/Pause State Transition
    if (isPlaying !== lastPlayingRef.current) {
      socketRef.current.send(JSON.stringify({
        event: isPlaying ? "play" : "pause",
        data: { timestamp: currentTime }
      }));
      lastPlayingRef.current = isPlaying;
      lastTimeRef.current = currentTime;
      return;
    }

    // 2. Manual Seek detection
    const diff = Math.abs(currentTime - lastTimeRef.current);
    if (diff > 2.5) {
      socketRef.current.send(JSON.stringify({
        event: "seek",
        data: { timestamp: currentTime }
      }));
    }
    lastTimeRef.current = currentTime;
  }, [isPlaying, currentTime, canControl]);

  const sendPlaybackState = (event: "play" | "pause" | "seek") => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      event,
      data: { timestamp: currentTime }
    }));
  };

  const handleDeleteRoom = async () => {
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}`), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        router.push("/rooms");
      } else {
        alert(json.error || "Failed to delete room.");
      }
    } catch (e) {
      console.error(e);
      alert("Error deleting room.");
    }
  };

  // Leave = close the socket. The backend's disconnect handling removes the
  // member from the room (and auto-transfers hosting if the host leaves), so no
  // dedicated leave endpoint is needed.
  const handleLeaveRoom = () => {
    socketRef.current?.close();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    setVoiceActive(false);
    router.push("/rooms");
  };

  const handleLeaveFromSheet = () => {
    setLeaving(true);
    // Close socket then navigate; the backend cleans membership on disconnect.
    handleLeaveRoom();
  };

  // Fetch the host's Circle friends so they can be invited directly into the room.
  const openInviteModal = async () => {
    if (!user) return;
    setInviteOpen(true);
    setInviteLoading(true);
    setInvitedMsg(null);
    try {
      const response = await authFetch(apiUrl("/social/circle"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setCircleFriends((json.data || []).map((f: any) => ({
          id: f.id,
          displayName: f.displayName,
          username: f.username,
          avatar: f.avatar,
        })));
      } else {
        setCircleFriends([]);
      }
    } catch (e) {
      console.error(e);
      setCircleFriends([]);
    } finally {
      setInviteLoading(false);
    }
  };

  const handleInviteFriend = async (friendId: string, friendName: string) => {
    if (!user) return;
    setInvitingId(friendId);
    setInvitedMsg(null);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/invite`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ userId: friendId })
      });
      const json = await response.json();
      if (json.success) {
        setInvitedMsg(`${friendName} was invited to ${room?.name ?? "your room"}.`);
      } else {
        setInvitedMsg(json.error || json.detail || "Invite failed.");
      }
    } catch (e) {
      console.error(e);
      setInvitedMsg("Unable to send the invite.");
    } finally {
      setInvitingId(null);
    }
  };

  const handleKickMember = async (memberId: string, memberName: string) => {
    if (!isHost) return;
    setKickingId(memberId);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/kick`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ userId: memberId })
      });
      const json = await response.json();
      if (!json.success) {
        show(json.error || json.detail || "Failed to kick that listener.", "error");
      } else {
        show(`${memberName} was removed from the room.`);
      }
    } catch (e) {
      console.error(e);
      show("Unable to reach the room server.", "error");
    } finally {
      setKickingId(null);
    }
  };

  const handleToggleController = (memberId: string) => {
    if (!canControl || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const controllers = room?.controllers || [];
    const isController = controllers.includes(memberId);
    socketRef.current.send(JSON.stringify({
      event: isController ? "room:controller-remove" : "room:controller-add",
      data: { userId: memberId }
    }));
  };

  const handleSuggestSearch = async () => {
    if (!suggestQuery.trim()) return;
    setSearchingSongs(true);
    try {
      const results = await searchYouTube({
        query: suggestQuery,
        type: "video"
      });
      setSuggestResults(results.songs);
    } catch (e) {
      console.error(e);
    } finally {
      setSearchingSongs(false);
    }
  };

  const handleAddSuggestedSong = (song: any) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      show("Your connection to the room is offline — try again in a moment.", "error");
      return;
    }
    socketRef.current.send(JSON.stringify({
      event: "queue:add",
      data: { song }
    }));
    setSuggestQuery("");
    setSuggestResults([]);
  };

  const handleAddToQueue = (song: any) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      show("Your connection to the room is offline — try again in a moment.", "error");
      return;
    }
    socketRef.current.send(JSON.stringify({
      event: "queue:add",
      data: { song }
    }));
    setAddedToQueue(prev => {
      const next = new Set(prev);
      next.add(song.videoId);
      return next;
    });
    window.setTimeout(() => {
      setAddedToQueue(prev => {
        const next = new Set(prev);
        next.delete(song.videoId);
        return next;
      });
    }, 2000);
  };

  const handleRemoveFromQueue = (videoId: string) => {
    if (!canControl || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      event: "queue:remove",
      data: { videoId }
    }));
  };

  const handleClearQueue = () => {
    if (!canControl || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      event: "queue:clear",
      data: {}
    }));
  };

  const handlePlayNow = (song: any) => {
    if (!canControl) return;
    playSong(song, [song]);
    setRoom(prev => prev ? { ...prev, currentTrack: song } : null);
  };

  const handleCopyCode = (code: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1500);
  };

  const handleRegenCode = async () => {
    if (!isHost) return;
    setRegeneratingCode(true);
    try {
      const response = await authFetch(apiUrl(`/social/rooms/${id}/join-code`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success && json.data?.joinCode) {
        setRoom(prev => prev ? { ...prev, joinCode: json.data.joinCode } : null);
        show("New invite code generated.");
      } else {
        show(json.error || json.detail || "Failed to regenerate the code.", "error");
      }
    } catch (e) {
      console.error(e);
      show("Unable to reach the room server.", "error");
    } finally {
      setRegeneratingCode(false);
    }
  };

  // WebRTC Signal Exchanger
  const sendSignal = (toUserId: string, signalData: any) => {
    if (!socketRef.current) return;
    socketRef.current.send(JSON.stringify({
      event: "signal",
      data: {
        to: toUserId,
        from: user?.id,
        signal: signalData
      }
    }));
  };

  const handleReceiveSignal = async (fromPeerId: string, signal: any) => {
    let pc = peerConnectionsRef.current[fromPeerId];
    if (!pc) {
      pc = createPeerConnection(fromPeerId);
    }

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromPeerId, { sdp: answer });
      }

      // Process any queued candidates for this peer
      const queued = pendingCandidatesRef.current[fromPeerId] || [];
      for (const cand of queued) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {}
      }
      delete pendingCandidatesRef.current[fromPeerId];

    } else if (signal.candidate) {
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.warn("Error adding Ice Candidate", e);
        }
      } else {
        if (!pendingCandidatesRef.current[fromPeerId]) {
          pendingCandidatesRef.current[fromPeerId] = [];
        }
        pendingCandidatesRef.current[fromPeerId].push(signal.candidate);
      }
    }
  };

  const createPeerConnection = (peerId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    peerConnectionsRef.current[peerId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, { candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      // Create element to output audio stream
      let audioEl = document.getElementById(`audio-peer-${peerId}`) as HTMLAudioElement;
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.id = `audio-peer-${peerId}`;
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = event.streams[0];
      // Explicitly trigger play to handle autoplay browser restrictions
      audioEl.play().catch(err => console.warn("Failed to autoplay peer audio:", err));
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    return pc;
  };

  // Toggle Voice Chat
  const toggleVoiceChat = async () => {
    if (voiceActive) {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
      peerConnectionsRef.current = {};
      setVoiceActive(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        setVoiceActive(true);

        // Initiate WebRTC to all existing members in Room details
        if (room) {
          room.membersProfiles.forEach(m => {
            if (m.id !== user?.id) {
              let pc = peerConnectionsRef.current[m.id];
              if (!pc) {
                pc = createPeerConnection(m.id);
              } else {
                // If peer connection already exists, add tracks to it
                stream.getTracks().forEach(track => {
                  pc.addTrack(track, stream);
                });
              }
              pc.createOffer().then(offer => {
                pc.setLocalDescription(offer);
                sendSignal(m.id, { sdp: offer });
              });
            }
          });
        }
      } catch (err) {
        show("Microphone permission is needed to activate the Voice Channel.", "error");
      }
    }
  };

  const handleSendChatMessage = () => {
    if (!inputText.trim() || !socketRef.current) return;
    socketRef.current.send(JSON.stringify({
      event: "chat:message",
      data: {
        senderName: user?.displayName || "Someone",
        text: inputText
      }
    }));
    setMessages(prev => [...prev, { sender: "You", text: inputText }]);
    setInputText("");
  };

  const activeListeners = (room?.membersProfiles || []).filter(m => activeMemberIds.has(m.id));

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Entering Strumm Room...</span>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3 text-center px-6">
        <MessageSquare className="w-8 h-8 text-primary" />
        <p className="text-sm">{roomError || "Room not found."}</p>
        <button
          onClick={() => {
            setLoading(true);
            fetchRoomInfo();
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/15 hover:bg-primary/30 text-primary text-xs font-medium transition cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full min-w-0 soft-enter pb-16">
      {/* Full-bleed blurred artwork backdrop */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        {room.currentTrack ? (
          <SongArtwork
            song={room.currentTrack}
            className="w-full h-full blur-3xl scale-110 opacity-30"
            quality={ARTWORK_QUALITY_LOW}
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-b from-surface-elevated/40 via-surface/10 to-background" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/30 to-background" />
      </div>

      {/* Top bar */}
      <div className="w-full px-4 md:px-6 pt-5 pb-4 border-b border-border/10 backdrop-blur-sm bg-background/30 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.push("/rooms")}
              className="p-2 -ml-1 hover:bg-surface-elevated/60 text-muted hover:text-text rounded-lg transition cursor-pointer"
              title="Back to Rooms"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="font-editorial text-lg font-bold text-text truncate max-w-full">{room.name}</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 px-2 py-0.5 text-[8px] uppercase tracking-wider font-bold shrink-0">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
                  </span>
                  {activeListeners.length} live
                </span>
              </div>
              <p className="text-[10px] text-muted mt-0.5 flex items-center gap-1.5 truncate">
                <Crown className="w-3 h-3 text-primary shrink-0" />
                <span className="truncate">{room.hostName}</span>
                <span className="opacity-50">·</span>
                <span className="capitalize">{room.visibility}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => { setCodeOpen(true); setCodeCopied(false); }}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface/60 border border-border/50 hover:bg-surface-elevated text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
              title="Invite code"
            >
              <KeyRound className="w-3.5 h-3.5 text-primary" />
              {room.joinCode || "-----"}
            </button>
            <button
              onClick={toggleVoiceChat}
              className={`p-2.5 rounded-lg border transition cursor-pointer ${
                voiceActive
                  ? "bg-green-500/10 border-green-500/30 text-green-400"
                  : "bg-surface/60 border-border/50 hover:bg-surface-elevated text-text"
              }`}
              title={voiceActive ? "Disconnect voice" : "Voice channel"}
            >
              {voiceActive ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            </button>
            {isHost && (
              <button
                onClick={openInviteModal}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Invite
              </button>
            )}
            <button
              onClick={() => setLeaveOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-surface/60 border border-border/50 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Leave
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 md:px-0 pt-10 space-y-8">
        {/* Now-playing stage */}
        <section className="flex flex-col items-center text-center gap-6 min-w-0">
          <div className="relative w-56 h-56 md:w-64 md:h-64 shrink-0">
            <div className="absolute inset-0 rounded-full bg-primary/20 blur-3xl opacity-60" />
            <SongArtwork
              song={room.currentTrack}
              className="relative w-full h-full rounded-3xl shadow-2xl shadow-black/60 ring-1 ring-white/10"
              quality={ARTWORK_QUALITY_HIGH}
              iconClassName="w-10 h-10"
              priority
            />
          </div>

          {room.currentTrack ? (
            <>
              <div className="min-w-0 max-w-2xl">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold inline-flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5" />
                  Now Synced
                </span>
                <h1 className="font-editorial text-3xl md:text-4xl font-bold text-text mt-1.5 truncate max-w-full leading-tight">
                  {room.currentTrack.title}
                </h1>
                <p className="text-sm text-muted mt-1 truncate max-w-full">
                  {room.currentTrack.artist || "—"}
                </p>
              </div>

              {/* Transport */}
              <div className="flex items-center gap-5">
                <button
                  onClick={() => {
                    setPlaying(!isPlaying);
                    sendPlaybackState(isPlaying ? "pause" : "play");
                  }}
                  disabled={!canControl}
                  className="w-14 h-14 rounded-full bg-primary text-white hover:bg-primary-hover hover:scale-105 transition shadow-xl shadow-primary/25 inline-flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                  title={canControl ? (isPlaying ? "Pause" : "Play") : "Only the host or controllers control playback"}
                >
                  {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
                </button>
                <div className="text-left">
                  <div className="text-xs font-mono text-text tabular-nums">
                    {formatTime(currentTime)} <span className="text-muted">/</span>{" "}
                    <span className="text-muted">{room.currentTrack.duration ? formatTime(room.currentTrack.duration) : "..."}</span>
                  </div>
                  <p className="text-[9px] uppercase tracking-widest text-muted mt-0.5">
                    {isPlaying ? "Playing now" : canControl ? "Paused" : "Room is paused"}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-2 min-w-0 max-w-xl">
              <h1 className="font-editorial text-2xl md:text-3xl font-bold text-text">Waiting for the first track</h1>
              <p className="text-sm text-muted">
                {canControl ? "Drop a song into the queue using the Suggest button to get the listening party going." : "The host hasn't loaded a song yet — sit tight."}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => setSuggestOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface/60 border border-border/50 hover:border-primary/50 text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-primary" />
              {canControl ? "Add a song" : "Suggest"}
            </button>
            <button
              onClick={() => { setCodeOpen(true); setCodeCopied(false); }}
              className="sm:hidden inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface/60 border border-border/50 hover:border-primary/50 text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5 text-primary" />
              {room.joinCode || "-----"}
            </button>
            {isHost && room.joinCode && (
              <button
                onClick={() => handleCopyCode(room.joinCode || "")}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface/60 border border-border/50 hover:border-primary/50 text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
              >
                {codeCopied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-primary" />}
                {codeCopied ? "Copied" : "Copy code"}
              </button>
            )}
          </div>
        </section>

        {/* Rail: Queue / Chat / Listeners */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start min-w-0">
          {/* Queue */}
          <section className="lg:col-span-8 space-y-4 min-w-0">
            <div className="flex items-center justify-between gap-3 min-w-0">
              <div className="flex items-center gap-1.5 rounded-xl bg-surface/50 border border-border/40 p-1">
                {([
                  ["queue", "Up Next", ListMusic],
                  ["chat", "Chat", MessageSquare],
                  ["people", "Listeners", Users],
                ] as Array<[RailTab, string, any]>).map(([tab, label, Icon]) => (
                  <button
                    key={tab}
                    onClick={() => setRailTab(tab)}
                    className={`px-3.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition cursor-pointer inline-flex items-center gap-1.5 ${
                      railTab === tab
                        ? "bg-primary text-white shadow"
                        : "text-muted hover:text-text"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                    {tab === "queue" && ` (${room.queue?.length || 0})`}
                    {tab === "people" && ` (${activeListeners.length})`}
                  </button>
                ))}
              </div>

              {railTab === "queue" && canControl && (room.queue?.length || 0) > 0 && (
                <button
                  onClick={handleClearQueue}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider text-muted hover:text-red-400 hover:bg-red-500/10 transition cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>

            {railTab === "queue" && (
              <div className="bg-surface/40 backdrop-blur-sm border border-border/50 rounded-2xl p-4 space-y-2 min-w-0">
                {(!room.queue || room.queue.length === 0) ? (
                  <p className="text-xs text-muted italic py-6 text-center">
                    No songs in the queue yet. Suggest one below to start the party.
                  </p>
                ) : (
                  <div className="divide-y divide-border/10">
                    {room.queue.filter(cleanQueueEntry).map((song, index) => (
                      <div key={`${song.videoId}-${index}`} className="flex items-center gap-3 py-2.5 text-xs min-w-0">
                        <span className="w-5 text-[10px] font-mono text-muted text-right shrink-0">{index + 1}</span>
                        <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/5">
                          <SongArtwork song={song} className="w-full h-full" quality={ARTWORK_QUALITY_LOW} iconClassName="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold text-text truncate block leading-snug">{song.title}</span>
                          <span className="text-[10px] text-muted truncate block mt-0.5">{song.artist || "—"}</span>
                        </div>
                        {canControl && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => handlePlayNow(song)}
                              className="w-7 h-7 rounded-lg bg-primary/15 hover:bg-primary/30 text-primary inline-flex items-center justify-center transition cursor-pointer"
                              title="Play now"
                            >
                              <Play className="w-3 h-3 ml-px" />
                            </button>
                            <button
                              onClick={() => handleRemoveFromQueue(song.videoId)}
                              className="w-7 h-7 rounded-lg bg-surface-elevated/60 hover:bg-red-500/10 text-muted hover:text-red-400 inline-flex items-center justify-center transition cursor-pointer"
                              title="Remove from queue"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {railTab === "chat" && (
              <div className="bg-surface/40 backdrop-blur-sm border border-border/50 rounded-2xl p-4 flex flex-col justify-between h-[420px] min-w-0">
                <div className="overflow-y-auto space-y-2 flex-1 pr-1 pb-3 text-xs">
                  {messages.map((m, idx) => (
                    <div key={idx} className="leading-relaxed">
                      <span className={`font-bold ${m.sender === "System" ? "text-primary" : m.sender === "You" ? "text-accent" : "text-text"}`}>
                        {m.sender}
                        {m.sender !== "System" && ":"}
                      </span>{" "}
                      <span className="text-muted/95">{m.text}</span>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                  {messages.length === 0 && (
                    <p className="text-xs text-muted italic text-center py-8">Say hi to the room.</p>
                  )}
                </div>

                <div className="flex gap-2 border-t border-border/20 pt-3">
                  <input
                    type="text"
                    placeholder="Say hello..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSendChatMessage()}
                    className="flex-1 bg-background border border-border/60 rounded-xl px-3 py-2 text-xs text-text focus:outline-none focus:border-primary/50"
                  />
                  <button
                    onClick={handleSendChatMessage}
                    className="p-2 bg-primary text-white rounded-xl hover:bg-primary-hover transition cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {railTab === "people" && (
              <div className="bg-surface/40 backdrop-blur-sm border border-border/50 rounded-2xl p-4 space-y-2 min-w-0">
                {activeListeners.length === 0 ? (
                  <p className="text-xs text-muted italic py-6 text-center">No listeners online right now.</p>
                ) : (
                  <div className="divide-y divide-border/10">
                    {room.membersProfiles
                      .filter(m => activeMemberIds.has(m.id))
                      .map((m) => {
                        const isRoomHost = m.id === room.hostId;
                        const isController = (room.controllers || []).includes(m.id);
                        const isMe = m.id === user?.id;
                        return (
                          <div key={m.id} className="flex items-center gap-3 py-2.5 min-w-0">
                            <div className="relative shrink-0">
                              {m.avatar ? (
                                <img src={m.avatar} alt={m.displayName} loading="lazy" decoding="async" className="w-9 h-9 rounded-full object-cover ring-1 ring-border" />
                              ) : (
                                <div className="w-9 h-9 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                                  <Users className="w-4 h-4 text-accent" />
                                </div>
                              )}
                              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-background" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="text-xs font-bold text-text truncate block leading-snug">
                                {m.displayName}
                                {isMe && <span className="text-muted font-normal"> (you)</span>}
                              </span>
                              <span className="text-[9px] text-muted truncate block mt-0.5 flex items-center gap-1">
                                {isRoomHost ? (
                                  <>
                                    <Crown className="w-3 h-3 text-primary" /> Host
                                  </>
                                ) : isController ? (
                                  <ShieldCheck className="w-3 h-3 text-accent" />
                                ) : (
                                  "Listener"
                                )}
                              </span>
                            </div>
                            {isHost && !isRoomHost && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  onClick={() => handleToggleController(m.id)}
                                  className={`px-2 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-wider transition cursor-pointer ${
                                    isController
                                      ? "bg-accent/15 text-accent hover:bg-accent/25"
                                      : "bg-surface-elevated/60 text-muted hover:text-text"
                                  }`}
                                  title={isController ? "Revoke control" : "Grant control"}
                                >
                                  {isController ? "Controller" : "Grant control"}
                                </button>
                                <button
                                  onClick={() => handleKickMember(m.id, m.displayName)}
                                  disabled={kickingId === m.id}
                                  className="w-7 h-7 rounded-lg bg-surface-elevated/60 hover:bg-red-500/10 text-muted hover:text-red-400 inline-flex items-center justify-center transition cursor-pointer disabled:opacity-50"
                                  title="Remove listener"
                                >
                                  {kickingId === m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Right rail: quick actions */}
          <aside className="lg:col-span-4 space-y-4 min-w-0">
            <button
              onClick={() => setSuggestOpen(true)}
              className="w-full p-5 rounded-2xl bg-gradient-to-br from-primary/15 via-surface/50 to-surface/30 border border-primary/20 hover:border-primary/50 transition text-left cursor-pointer group"
            >
              <div className="flex items-center gap-2 text-primary">
                <Search className="w-4 h-4" />
                <span className="text-[10px] uppercase tracking-widest font-bold">Suggest songs</span>
              </div>
              <p className="text-xs text-text mt-2 font-semibold group-hover:text-primary transition">
                {canControl ? "Search & drop the next track" : "Add your pick to the queue"}
              </p>
              <p className="text-[10px] text-muted mt-1">Powering the room&apos;s collaborative queue.</p>
            </button>

            <div className="rounded-2xl bg-surface/40 backdrop-blur-sm border border-border/50 p-5 space-y-3 min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-muted">Join this room</span>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-3 py-2.5 text-lg font-mono tracking-[0.25em] text-primary text-center">
                  {room.joinCode || "-----"}
                </div>
                <button
                  onClick={() => handleCopyCode(room.joinCode || "")}
                  className="p-2.5 rounded-xl border border-border/50 hover:bg-surface-elevated text-muted hover:text-text transition cursor-pointer"
                  title="Copy invite code"
                >
                  {codeCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[10px] text-muted leading-relaxed">
                Share this code with friends — they can enter it from the Rooms lobby.
              </p>
              {isHost && (
                <button
                  onClick={handleRegenCode}
                  disabled={regeneratingCode}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-xl border border-border/50 hover:bg-surface-elevated text-text text-[10px] font-bold uppercase tracking-wider transition cursor-pointer disabled:opacity-50"
                >
                  {regeneratingCode ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-primary" />}
                  New code
                </button>
              )}
            </div>

            <div className="rounded-2xl bg-surface/40 backdrop-blur-sm border border-border/50 p-5 space-y-2.5 min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-muted">About this room</span>
              <p className="text-[11px] text-text/90 leading-relaxed">
                Playback, queue, and voice are synced on your own player. The host controls the
                mic and who can drive the music — controllers can play tracks too.
              </p>
            </div>
          </aside>
        </div>
      </div>

      {/* Suggest songs sheet */}
      {suggestOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setSuggestOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-lg bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-4 soft-enter max-h-[85vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between min-w-0">
              <div className="min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Collaborative queue</span>
                <h3 className="font-editorial text-xl font-bold text-text mt-0.5">{canControl ? "Add the next track" : "Suggest a song"}</h3>
              </div>
              <button
                onClick={() => setSuggestOpen(false)}
                className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search song titles..."
                value={suggestQuery}
                onChange={(e) => setSuggestQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSuggestSearch()}
                className="flex-1 bg-background border border-border/60 rounded-xl px-4 py-2.5 text-xs text-text focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={handleSuggestSearch}
                disabled={searchingSongs}
                className="px-4 py-2.5 bg-primary text-white text-xs font-semibold rounded-xl hover:bg-primary-hover transition cursor-pointer disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {searchingSongs ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Search
              </button>
            </div>

            {suggestResults.length > 0 && (
              <div className="divide-y divide-border/10 font-sans max-h-80 overflow-y-auto pr-1">
                {suggestResults.map((song) => (
                  <div key={song.videoId} className="flex justify-between items-center py-2.5 text-xs min-w-0">
                    <div className="min-w-0 flex-1 flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/5">
                        <SongArtwork song={song} className="w-full h-full" quality={ARTWORK_QUALITY_LOW} iconClassName="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <span className="font-semibold text-text truncate block">{song.title}</span>
                        <span className="text-[10px] text-muted truncate block mt-0.5">{song.artist}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5 ml-3 shrink-0">
                      {canControl ? (
                        <>
                          <button
                            onClick={() => { handlePlayNow(song); setSuggestOpen(false); }}
                            className="px-2.5 py-1.5 bg-primary/15 hover:bg-primary/30 text-primary font-bold rounded-lg text-[10px] transition cursor-pointer whitespace-nowrap"
                          >
                            Play Now
                          </button>
                          <button
                            onClick={() => handleAddToQueue(song)}
                            disabled={addedToQueue.has(song.videoId)}
                            className="px-2.5 py-1.5 bg-accent/15 hover:bg-accent/30 text-accent font-bold rounded-lg text-[10px] transition cursor-pointer disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1"
                          >
                            {addedToQueue.has(song.videoId) ? (
                              <>
                                <Check className="w-3 h-3" />
                                Added
                              </>
                            ) : (
                              "Add"
                            )}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleAddSuggestedSong(song)}
                          disabled={addedToQueue.has(song.videoId)}
                          className="px-2.5 py-1.5 bg-accent/15 hover:bg-accent/30 text-accent font-bold rounded-lg text-[10px] transition cursor-pointer disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1"
                        >
                          {addedToQueue.has(song.videoId) ? (
                            <>
                              <Check className="w-3 h-3" />
                              Suggested
                            </>
                          ) : (
                            "Suggest"
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {suggestQuery.trim() && !searchingSongs && suggestResults.length === 0 && (
              <p className="text-xs text-muted italic text-center py-4">No songs found for that search.</p>
            )}
            {!suggestQuery.trim() && (
              <p className="text-xs text-muted italic text-center py-4">
                Search for any song — anyone in the room can see suggestions.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Invite sheet (host) */}
      {inviteOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setInviteOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-sm bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-4 soft-enter max-h-[85vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between min-w-0">
              <div className="min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Invite to room</span>
                <h3 className="font-editorial text-xl font-bold text-text mt-0.5 truncate">Invite Circle friends</h3>
              </div>
              <button
                onClick={() => setInviteOpen(false)}
                className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {invitedMsg && (
              <div className="text-[10px] text-primary bg-primary/5 border border-primary/20 p-2.5 rounded-lg">
                {invitedMsg}
              </div>
            )}

            {inviteLoading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-xs text-muted">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>Loading your Circle...</span>
              </div>
            ) : circleFriends.length === 0 ? (
              <p className="text-xs text-muted italic p-4 text-center">
                No Circle friends to invite yet. Add friends from the Circle tab first.
              </p>
            ) : (
              <div className="space-y-2">
                {circleFriends.map((friend) => (
                  <div key={friend.id} className="flex items-center justify-between gap-2 p-2.5 bg-surface-elevated/20 border border-border/40 rounded-xl min-w-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {friend.avatar ? (
                        <img src={friend.avatar} alt={friend.displayName} loading="lazy" decoding="async" className="w-7 h-7 rounded-full object-cover flex-shrink-0 border border-border" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-surface border border-border flex items-center justify-center flex-shrink-0">
                          <Users className="w-3.5 h-3.5 text-accent" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-bold text-text truncate block leading-snug">{friend.displayName}</span>
                        <span className="text-[9px] text-muted truncate block">@{friend.username}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleInviteFriend(friend.id, friend.displayName)}
                      disabled={invitingId === friend.id}
                      className="px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-[10px] font-semibold rounded-lg flex items-center gap-1 transition cursor-pointer select-none disabled:opacity-50 flex-shrink-0"
                    >
                      {invitingId === friend.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Check className="w-3 h-3" />
                      )}
                      {invitingId === friend.id ? "Inviting..." : "Invite"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Join-code sheet */}
      {codeOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setCodeOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-sm bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-4 soft-enter"
          >
            <div className="flex items-start justify-between min-w-0">
              <div className="min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Share this room</span>
                <h3 className="font-editorial text-xl font-bold text-text mt-0.5">{room.name}</h3>
              </div>
              <button
                onClick={() => setCodeOpen(false)}
                className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-6 text-center space-y-2">
              <span className="text-[9px] uppercase tracking-widest text-primary font-bold block">Invite code</span>
              <div className="text-3xl font-mono tracking-[0.35em] text-text">
                {room.joinCode || "-----"}
              </div>
            </div>

            <button
              onClick={() => handleCopyCode(room.joinCode || "")}
              className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-xl transition cursor-pointer inline-flex items-center justify-center gap-2"
            >
              {codeCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {codeCopied ? "Copied to clipboard" : "Copy invite code"}
            </button>
            <p className="text-[10px] text-muted text-center leading-relaxed">
              Friends can paste this code into the &quot;Enter with Code&quot; field in the Rooms lobby.
            </p>
          </div>
        </div>
      )}

      {/* Leave / Delete sheet */}
      {leaveOpen && (
        <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={() => setLeaveOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-sm bg-surface border border-border/85 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl space-y-4 soft-enter"
          >
            <div className="min-w-0">
              <span className="text-[9px] uppercase tracking-widest text-red-400 font-bold block">Leave room</span>
              <h3 className="font-editorial text-xl font-bold text-text mt-0.5">
                {isHost ? "End the listening party?" : "Leave the room?"}
              </h3>
              <p className="text-xs text-muted mt-2 leading-relaxed">
                {isHost
                  ? "As the host, leaving transfers hosting to another listener. You can also delete the room to disconnect everyone."
                  : "You can rejoin anytime with the invite code."}
              </p>
            </div>

            <div className="space-y-2">
              {isHost && (
                <button
                  onClick={handleDeleteRoom}
                  className="w-full py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 text-red-400 text-xs font-semibold transition cursor-pointer inline-flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete room & disconnect everyone
                </button>
              )}
              <button
                onClick={handleLeaveFromSheet}
                disabled={leaving}
                className="w-full py-2.5 rounded-xl bg-surface-elevated border border-border/60 hover:bg-surface-elevated/80 text-text text-xs font-semibold transition cursor-pointer inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {leaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                {isHost ? "Transfer hosting & leave" : "Leave room"}
              </button>
              <button
                onClick={() => setLeaveOpen(false)}
                className="w-full py-2.5 rounded-xl border border-border/40 text-muted hover:text-text text-xs font-semibold transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}