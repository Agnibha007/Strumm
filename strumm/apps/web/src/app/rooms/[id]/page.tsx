"use client";

import { useEffect, useRef, useState, use } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { apiUrl } from "web/lib/api";
import { searchInvidious } from "web/lib/invidious";
import { Users, Radio, Play, Pause, SkipForward, Send, Mic, MicOff, Loader2, Sparkles } from "lucide-react";
import SongArtwork from "web/components/SongArtwork";
import { useRouter } from "next/navigation";

interface RoomDetails {
  id: string;
  name: string;
  hostId: string;
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
}

export default function RoomDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  
  const { token, user } = useAuthStore();
  const { currentSong, isPlaying, currentTime, setCurrentTime, playSong, setPlaying, playerRef, addToQueue } = usePlayerStore();
  
  const [room, setRoom] = useState<RoomDetails | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Track currently active members using WebSocket join/leave events
  const [activeMemberIds, setActiveMemberIds] = useState<Set<string>>(new Set());
  
  // WebSocket and WebRTC Refs
  const socketRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  
  // UI states
  const [messages, setMessages] = useState<Array<{ sender: string; text: string }>>([]);
  const [inputText, setInputText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const isHost = room && user ? room.hostId === user.id : false;
  const [suggestQuery, setSuggestQuery] = useState("");
  const [suggestResults, setSuggestResults] = useState<any[]>([]);

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

  // Fetch Room Info
  const fetchRoomInfo = async () => {
    if (!token) return;
    try {
      const response = await fetch(apiUrl(`/social/rooms/${id}`), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setRoom(json.data);
        // Initialize active members with all members from initial fetch
        // (will be updated in real-time via WebSocket)
        setActiveMemberIds(new Set(json.data.members.map((m: any) => m.id)));
      }
    } catch (e) {
      console.error("Failed to load room details:", e);
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

  // Connect WebSocket
  useEffect(() => {
    if (!token || !user?.id || !room) return;

    let baseWs = apiUrl("").replace(/^http/, "ws");
    if (baseWs.endsWith("/")) {
      baseWs = baseWs.slice(0, -1);
    }
    const wsUrl = baseWs + `/social/rooms/${id}/ws?userId=${user.id}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    // Add current user to active members on connect
    setActiveMemberIds(prev => new Set([...prev, user.id]));

    ws.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      const { event: wsEvent, data: eventData } = payload;

      if (wsEvent === "room:join") {
        setMessages(prev => [...prev, { sender: "System", text: `A listener joined the room.` }]);
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
      
      else if (wsEvent === "room:leave") {
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
      
      else if (wsEvent === "chat:message") {
        setMessages(prev => [...prev, { sender: eventData.senderName, text: eventData.text }]);
      } 
      
      else if (wsEvent === "track:update") {
        if (!isHostRef.current) {
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
        addToQueue(eventData.song);
        setRoom(prev => prev ? { ...prev, queue: [...(prev.queue || []), eventData.song] } : null);
      } 
      
      else if (wsEvent === "room:deleted" || payload.type === "room_deleted") {
        alert("This Strumm Room has been deleted by the host.");
        router.push("/rooms");
      }
      
      else if (wsEvent === "signal") {
        const { from, signal } = eventData;
        // WebRTC Signaling Answer/Offer/Candidate Processing
        if (eventData.to === user.id) {
          await handleReceiveSignal(from, signal);
        }
      }
    };

    return () => {
      // Remove current user from active members on disconnect
      setActiveMemberIds(prev => {
        const next = new Set(prev);
        next.delete(user?.id);
        return next;
      });
      ws.close();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
      Object.values(peerConnectionsRef.current).forEach(pc => pc.close());
    };
  }, [token, room?.id, user?.id]);

  // Host Action Broadcasters
  useEffect(() => {
    if (!isHost || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

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
  }, [currentSong?.videoId, isHost]);

  // Host Playback Sync Broadcaster
  const lastTimeRef = useRef(currentTime);
  const lastPlayingRef = useRef(isPlaying);

  useEffect(() => {
    if (!isHost || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

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
  }, [isPlaying, currentTime, isHost]);

  const sendPlaybackState = (event: "play" | "pause" | "seek") => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      event,
      data: { timestamp: currentTime }
    }));
  };

  const handleDeleteRoom = async () => {
    if (!confirm("Are you sure you want to delete this room? This will disconnect all listeners.")) return;
    try {
      const response = await fetch(apiUrl(`/social/rooms/${id}`), {
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

  const handleSuggestSearch = async () => {
    if (!suggestQuery.trim()) return;
    try {
      const results = await searchInvidious({
        query: suggestQuery,
        type: "video"
      });
      setSuggestResults(results.songs);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddSuggestedSong = (song: any) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      event: "queue:add",
      data: { song }
    }));
    setSuggestQuery("");
    setSuggestResults([]);
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
        alert("Microphone permission requested to activate Voice Channel.");
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

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Entering Strumm Room...</span>
      </div>
    );
  }

  if (!room) return null;

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12 w-full px-4 md:px-0 min-w-0">
      {/* Title */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 min-w-0 border-b border-border/20 pb-4">
        <div className="min-w-0">
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Strumm Room
          </span>
          <h2 className="text-2xl font-editorial font-bold text-text truncate max-w-full">
            {room.name}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleVoiceChat}
            className={`py-2 px-4 rounded-xl text-xs font-semibold flex items-center gap-2 cursor-pointer transition ${
              voiceActive 
                ? "bg-green-500/10 border border-green-500/30 text-green-400" 
                : "bg-surface border border-border/60 hover:bg-surface-elevated text-text"
            }`}
          >
            {voiceActive ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            {voiceActive ? "Voice Connected" : "Voice Channel"}
          </button>
          
          {isHost && (
            <button
              onClick={handleDeleteRoom}
              className="py-2 px-4 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold cursor-pointer transition"
            >
              Delete Room
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start min-w-0">
        
        {/* Left pane: Playback state + suggestions */}
        <div className="lg:col-span-8 space-y-6 min-w-0">
          
          {/* Synchronized Song Display */}
          <div className="bg-surface/40 border border-border/60 p-6 rounded-2xl flex flex-col md:flex-row items-center gap-6 min-w-0">
            <SongArtwork song={room.currentTrack} className="w-32 h-32 rounded shadow-2xl flex-shrink-0" />
            <div className="min-w-0 flex-1 text-center md:text-left">
              {room.currentTrack ? (
                <>
                  <span className="text-[9px] uppercase tracking-wider text-primary font-bold">Now Synced</span>
                  <h3 className="font-editorial text-2xl font-bold text-text mt-1 truncate max-w-full">
                    {room.currentTrack.title}
                  </h3>
                  <p className="text-sm text-muted truncate mt-0.5 max-w-full">
                    {room.currentTrack.artist}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted italic">Waiting for host to load a song...</p>
              )}

              {/* Host Control Actions */}
              {isHost && room.currentTrack && (
                <div className="flex items-center justify-center md:justify-start gap-4 mt-4">
                  <button
                    onClick={() => {
                      setPlaying(!isPlaying);
                      sendPlaybackState(isPlaying ? "pause" : "play");
                    }}
                    className="p-3 bg-primary text-white rounded-full transition shadow hover:scale-105"
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>
                  <button
                    onClick={() => sendPlaybackState("seek")}
                    className="px-3 py-1.5 border border-border hover:bg-surface-elevated text-xs font-semibold rounded-lg transition"
                  >
                    Sync Seek Timestamps
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Collaborative Queue List */}
          <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-4 min-w-0">
            <h3 className="font-editorial text-lg text-text font-bold flex items-center gap-2">
              <Radio className="w-5 h-5 text-primary animate-pulse" /> Collaborative Queue ({room.queue?.length || 0})
            </h3>
            {(!room.queue || room.queue.length === 0) ? (
              <p className="text-xs text-muted italic pb-2">No songs in the queue yet. Suggest some below!</p>
            ) : (
              <div className="divide-y divide-border/20 font-sans max-h-60 overflow-y-auto pr-1">
                {room.queue.map((song, index) => (
                  <div key={`${song.videoId}-${index}`} className="flex justify-between items-center py-3 text-xs">
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <SongArtwork song={song} className="w-10 h-10 rounded object-cover flex-shrink-0" />
                      <div className="min-w-0">
                        <span className="font-semibold text-text truncate block">{song.title}</span>
                        <span className="text-[10px] text-muted truncate block">{song.artist}</span>
                      </div>
                    </div>
                    {isHost && (
                      <button
                        onClick={() => {
                          playSong(song, [song]);
                          setRoom(prev => prev ? { ...prev, currentTrack: song } : null);
                        }}
                        className="px-3 py-1 bg-primary/20 hover:bg-primary/40 text-primary font-bold rounded text-[10px] transition cursor-pointer"
                      >
                        Play Now
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Collaborative Queue Song suggestion inputs */}
          <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-4 min-w-0">
            <h3 className="font-editorial text-lg text-text font-bold">
              {isHost ? "Search & Control Music" : "Suggest Songs"}
            </h3>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search song titles..."
                value={suggestQuery}
                onChange={(e) => setSuggestQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSuggestSearch()}
                className="flex-1 bg-background border border-border/60 rounded-xl px-4 py-2 text-xs text-text focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={handleSuggestSearch}
                className="px-4 py-2 bg-primary text-white text-xs font-semibold rounded-xl hover:bg-primary-hover transition cursor-pointer"
              >
                Search
              </button>
            </div>

            {suggestResults.length > 0 && (
              <div className="divide-y divide-border/20 font-sans max-h-40 overflow-y-auto pr-1">
                {suggestResults.map((song) => (
                  <div key={song.videoId} className="flex justify-between items-center py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-text truncate block">{song.title}</span>
                      <span className="text-[10px] text-muted truncate block">{song.artist}</span>
                    </div>
                    <div className="flex gap-2 ml-4">
                      {isHost ? (
                        <>
                          <button
                            onClick={() => playSong(song, [song])}
                            className="px-2.5 py-1 bg-primary/20 hover:bg-primary/40 text-primary font-bold rounded text-[10px] transition cursor-pointer whitespace-nowrap"
                          >
                            Play Now
                          </button>
                          <button
                            onClick={() => {
                              if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                                socketRef.current.send(JSON.stringify({
                                  event: "queue:add",
                                  data: { song }
                                }));
                              }
                            }}
                            className="px-2.5 py-1 bg-accent/20 hover:bg-accent/40 text-accent font-bold rounded text-[10px] transition cursor-pointer whitespace-nowrap"
                          >
                            Add to Queue
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleAddSuggestedSong(song)}
                          className="px-2.5 py-1 bg-accent/20 hover:bg-accent/40 text-accent font-bold rounded text-[10px] transition cursor-pointer whitespace-nowrap"
                        >
                          Suggest
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right pane: Room members, Chatbox */}
        <div className="lg:col-span-4 space-y-6 min-w-0">
          
          {/* Active Members */}
          <div className="bg-surface/30 border border-border/60 rounded-2xl p-5 space-y-4 min-w-0">
            <h3 className="font-editorial text-base text-text font-bold border-b border-border/20 pb-2">
              Active Listeners ({room.membersProfiles.filter(m => activeMemberIds.has(m.id)).length})
            </h3>
            <div className="flex flex-wrap gap-2.5 max-h-40 overflow-y-auto">
              {room.membersProfiles
                .filter(m => activeMemberIds.has(m.id))
                .map((m) => (
                <div key={m.id} className="flex items-center gap-2 p-1.5 bg-surface-elevated/40 border border-border/40 rounded-xl max-w-full">
                  {m.avatar ? (
                    <img src={m.avatar} alt="" loading="lazy" decoding="async" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-surface border border-border flex items-center justify-center flex-shrink-0">
                      <Users className="w-3.5 h-3.5 text-accent" />
                    </div>
                  )}
                  <span className="text-[10px] font-bold text-text truncate">{m.displayName}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Simple text ChatBox */}
          <div className="bg-surface/35 border border-border/60 rounded-2xl p-5 flex flex-col justify-between h-[360px] min-w-0">
            <div className="overflow-y-auto space-y-2 flex-1 pr-1 pb-3 text-xs">
              {messages.map((m, idx) => (
                <div key={idx} className="leading-relaxed">
                  <span className={`font-bold ${m.sender === "System" ? "text-primary" : m.sender === "You" ? "text-accent" : "text-text"}`}>
                    {m.sender}:{" "}
                  </span>
                  <span className="text-muted/95">{m.text}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2 border-t border-border/20 pt-3">
              <input
                type="text"
                placeholder="Say hello..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendChatMessage()}
                className="flex-1 bg-background border border-border/60 rounded-xl px-3 py-1.5 text-xs text-text focus:outline-none focus:border-primary/50"
              />
              <button
                onClick={handleSendChatMessage}
                className="p-2 bg-primary text-white rounded-xl hover:bg-primary-hover transition cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
