"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { apiUrl } from "web/lib/api";
import { Users, Sparkles, UserMinus, Check, X, Bell, Play, Send, Trash2, RefreshCw, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePlayerStore } from "web/store/usePlayerStore";
import {
  EventDispatcher,
  USER_ONLINE,
  USER_OFFLINE,
  USER_LISTENING,
  USER_NOT_LISTENING,
  WS_CONNECTED,
} from "web/services/realtime";

interface Friend {
  id: string;
  displayName: string;
  username: string;
  avatar?: string;
  tasteMatch: number;
  isOnline?: boolean;
  currentActivity?: {
    song: {
      videoId: string;
      title: string;
      artist: string;
      thumbnail: string;
    };
    timestamp: string;
  } | null;
}

interface RequestItem {
  id: string;
  requesterId: string;
  tasteMatch: number;
  sender?: {
    id: string;
    displayName: string;
    username: string;
    avatar?: string;
  };
}

interface NotificationItem {
  id: string;
  type: string;
  senderName: string;
  senderAvatar?: string;
  message?: string;
  song?: any;
  read: boolean;
  createdAt: string;
}

export default function CirclePage() {
  const { token } = useAuthStore();
  const { playSong } = usePlayerStore();
  
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<RequestItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
 
  // Direct Message/Song Share Modal States
  const [sharingTarget, setSharingTarget] = useState<Friend | null>(null);
  const [shareMessage, setShareMessage] = useState("");
  const [includeSong, setIncludeSong] = useState(true);
  const [sendingShare, setSendingShare] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const refreshCountRef = useRef(0);

  const closeShareModal = () => {
    setSharingTarget(null);
    setShareMessage("");
    setIncludeSong(true);
    setSendingShare(false);
    setShareError(null);
  };

  const handleSendShare = async () => {
    if (!token || !sharingTarget) return;
    setSendingShare(true);
    setShareError(null);
    try {
      const currentSong = usePlayerStore.getState().currentSong;
      const response = await fetch(apiUrl("/social/message"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          receiverId: sharingTarget.id,
          message: shareMessage.trim() || undefined,
          song: includeSong ? currentSong : undefined
        })
      });
      const json = await response.json();
      if (json.success) {
        closeShareModal();
        alert("Your wave has been sent!");
      } else {
        setShareError(json.error || "Failed to send wave.");
      }
    } catch (e) {
      setShareError("Unable to connect to backend server.");
    } finally {
      setSendingShare(false);
    }
  };

  const loadCircleData = useCallback(async () => {
    if (!token) return;
    try {
      // Use combined endpoint for better performance
      const resp = await fetch(apiUrl("/social/circle/all"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await resp.json();

      if (json.success) {
        if (json.data.friends) setFriends(json.data.friends);
        if (json.data.requests) setIncomingRequests(json.data.requests);
        if (json.data.notifications) setNotifications(json.data.notifications);
      }
      setLastRefreshed(new Date());
    } catch (e) {
      setError("Failed to fetch Strumm Circle data.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const handleManualRefresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    await loadCircleData();
    refreshCountRef.current = 0;
  }, [loadCircleData, token]);

  useEffect(() => {
    if (!token) return;

    // Initial fetch
    loadCircleData();

    const dispatch = EventDispatcher.getInstance();

    // Subscribe to real-time updates
    const unsubOnline = dispatch.on(USER_ONLINE, (data) => {
      setFriends((prev) =>
        prev.map((f) => (f.id === data.id ? { ...f, isOnline: true } : f)),
      );
    });

    const unsubOffline = dispatch.on(USER_OFFLINE, (data) => {
      setFriends((prev) =>
        prev.map((f) =>
          f.id === data.id ? { ...f, isOnline: false, currentActivity: null } : f,
        ),
      );
    });

    const unsubListening = dispatch.on(USER_LISTENING, (data) => {
      setFriends((prev) =>
        prev.map((f) =>
          f.id === data.id
            ? {
                ...f,
                isOnline: true,
                currentActivity: data.song
                  ? {
                      song: data.song,
                      timestamp: data.timestamp,
                    }
                  : f.currentActivity,
              }
            : f,
        ),
      );
    });

    const unsubNotListening = dispatch.on(USER_NOT_LISTENING, (data) => {
      setFriends((prev) =>
        prev.map((f) =>
          f.id === data.id ? { ...f, currentActivity: null } : f,
        ),
      );
    });

    const unsubConnected = dispatch.on(WS_CONNECTED, () => {
      // Refresh full data when WebSocket reconnects
      loadCircleData();
    });

    // Visibility change: refresh data when user returns to the tab
    const handleVisibilityChange = () => {
      if (!document.hidden && token) {
        loadCircleData();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubOnline();
      unsubOffline();
      unsubListening();
      unsubNotListening();
      unsubConnected();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [token, loadCircleData]);

  const handleAccept = async (requestId: string) => {
    if (!token) return;
    setActionLoading(requestId);
    try {
      const res = await fetch(apiUrl(`/social/accept/${requestId}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setIncomingRequests(prev => prev.filter(r => r.id !== requestId));
        loadCircleData();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async (friendId: string) => {
    if (!token) return;
    setActionLoading(friendId);
    try {
      const res = await fetch(apiUrl(`/social/remove/${friendId}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setFriends(prev => prev.filter(f => f.id !== friendId));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateBlend = async (friendId: string) => {
    if (!token) return;
    setActionLoading(friendId + "-blend");
    try {
      const res = await fetch(apiUrl(`/social/blend/${friendId}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success && json.data?.id) {
        window.location.href = `/playlist/${json.data.id}`;
      } else {
        alert(json.error || json.detail || "Not enough music compatibility between you to generate a Blend playlist.");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to connect to the blend generation server.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleClearNotifications = async () => {
    if (!token) return;
    try {
      await fetch(apiUrl("/social/notifications/clear"), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteAllNotifications = async () => {
    if (!token) return;
    if (!confirm("Are you sure you want to permanently delete all notifications?")) return;
    try {
      await fetch(apiUrl("/social/notifications"), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      setNotifications([]);
    } catch (e) {
      console.error(e);
    }
  };

  const renderShareModal = () => {
    if (!sharingTarget) return null;
    const currentSong = usePlayerStore.getState().currentSong;

    return (
      <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-background/85 backdrop-blur-sm">
        <div className="w-full max-w-sm bg-surface border border-border/80 rounded-2xl p-5 shadow-2xl space-y-4">
          <div className="flex items-center justify-between border-b border-border/20 pb-3">
            <div className="min-w-0">
              <span className="text-[8px] uppercase tracking-widest text-primary font-bold block">Direct Wave</span>
              <h3 className="font-editorial text-base text-text font-bold truncate leading-tight">
                Send to {sharingTarget.displayName}
              </h3>
            </div>
            <button
              onClick={closeShareModal}
              className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition cursor-pointer"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-[9px] uppercase tracking-wider text-muted font-bold">Your message</label>
              <textarea
                value={shareMessage}
                onChange={(e) => setShareMessage(e.target.value)}
                placeholder="Type a custom note (optional)..."
                className="w-full bg-background/50 border border-border/80 focus:border-primary/50 rounded-xl px-3 py-2.5 text-xs text-text focus:outline-none transition resize-none"
                rows={3}
              />
            </div>

            {currentSong ? (
              <div className="p-3 bg-surface-elevated/40 border border-border/40 rounded-xl space-y-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="attach-song"
                    checked={includeSong}
                    onChange={(e) => setIncludeSong(e.target.checked)}
                    className="w-4 h-4 rounded accent-primary border-border focus:ring-primary focus:ring-offset-background cursor-pointer"
                  />
                  <label htmlFor="attach-song" className="text-[10px] text-text font-semibold cursor-pointer select-none">
                    Attach Currently Playing Track
                  </label>
                </div>
                {includeSong && (
                  <div className="p-2 bg-background/30 border border-border/20 rounded-lg flex items-center gap-2 min-w-0">
                    <img src={currentSong.thumbnail} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] text-text font-semibold block truncate leading-snug">{currentSong.title}</span>
                      <span className="text-[9px] text-muted block truncate">{currentSong.artist}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted italic">No track is currently playing in your player to attach.</p>
            )}
          </div>

          {shareError && (
            <div className="text-[10px] text-primary bg-primary/5 border border-primary/20 p-2.5 rounded-lg">
              {shareError}
            </div>
          )}

          <div className="flex gap-2 justify-end border-t border-border/20 pt-4">
            <button
              type="button"
              onClick={closeShareModal}
              className="px-3.5 py-1.5 border border-border text-text text-xs font-semibold rounded-lg hover:bg-surface-elevated transition cursor-pointer select-none"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={sendingShare}
              onClick={handleSendShare}
              className="px-4 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition cursor-pointer select-none disabled:opacity-50"
            >
              {sendingShare ? "Sending..." : "Send Wave"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (!token) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center p-6 gap-4">
        <Users className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Circle Locked</h3>
        <p className="text-sm text-muted">Please log in to manage your Strumm Circle.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Opening Circle Gates...</span>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-10 pb-12 w-full px-4 md:px-0 min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-start min-w-0">
        <div className="min-w-0">
          <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
            Strumm Social
          </span>
          <h2 className="text-3xl sm:text-4xl font-editorial text-text tracking-tight font-bold mt-1">
            Your Circle
          </h2>
          <p className="text-sm text-muted mt-2 max-w-xl line-clamp-2">
            Social space strictly built around music identity, shared memories, and joint listening.
          </p>
          {lastRefreshed && (
            <p className="text-[10px] text-muted mt-1">
              Last updated: {lastRefreshed.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {notifications.some(n => !n.read) && (
            <button
              onClick={handleClearNotifications}
              className="p-2.5 bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition rounded-xl flex items-center gap-2 text-xs font-semibold"
            >
              <Bell className="w-4 h-4 animate-bounce" />
              Clear Alerts
            </button>
          )}
          <button
            onClick={handleManualRefresh}
            disabled={loading}
            className="p-2.5 bg-surface-elevated border border-border/60 hover:border-primary/40 hover:bg-surface transition rounded-xl flex items-center gap-2 text-xs font-semibold text-muted hover:text-text disabled:opacity-50"
            title="Refresh circle data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start min-w-0">
        {/* Left column: Connections, Invitations */}
        <div className="lg:col-span-8 space-y-8 min-w-0">
          
          {/* Incoming invitations */}
          {incomingRequests.length > 0 && (
            <div className="space-y-4 min-w-0">
              <h3 className="font-editorial text-xl text-text font-bold border-b border-border/20 pb-2">
                Incoming Invitations ({incomingRequests.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {incomingRequests.map((req) => (
                  <div
                    key={req.id}
                    className="p-4 bg-surface/50 border border-border/60 rounded-xl flex items-center justify-between min-w-0 gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {req.sender?.avatar ? (
                        <img src={req.sender.avatar} alt="" loading="lazy" decoding="async" className="w-10 h-10 rounded-full object-cover shadow border border-border/40 flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-surface-elevated border border-border flex items-center justify-center flex-shrink-0">
                          <Users className="w-5 h-5 text-accent" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <Link href={`/@${req.sender?.username}`}>
                          <span className="font-bold text-text text-sm hover:underline cursor-pointer block truncate">
                            {req.sender?.displayName}
                          </span>
                        </Link>
                        <span className="text-[10px] text-primary font-bold block mt-0.5">
                          {req.tasteMatch}% Taste Match
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        disabled={actionLoading === req.id}
                        onClick={() => handleAccept(req.id)}
                        className="p-1.5 bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition rounded-lg"
                        title="Accept into Circle"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        disabled={actionLoading === req.id}
                        onClick={() => handleRemove(req.sender?.id || "")}
                        className="p-1.5 border border-border hover:bg-surface-elevated text-muted rounded-lg transition"
                        title="Decline invitation"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Circle connections list */}
          <div className="space-y-4 min-w-0">
            <h3 className="font-editorial text-xl text-text font-bold border-b border-border/20 pb-2">
              Circle Members ({friends.length})
            </h3>
            {friends.length === 0 ? (
              <div className="p-8 border border-dashed border-border/60 rounded-2xl text-center bg-surface/20 space-y-2">
                <Users className="w-8 h-8 text-muted mx-auto opacity-70" />
                <h4 className="font-editorial text-base text-text font-bold">Your Circle is quiet</h4>
                <p className="text-xs text-muted max-w-sm mx-auto">
                  Find user passports via Search directory or share your passport handle to build your music connection circle.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {friends.map((friend) => (
                  <div
                    key={friend.id}
                    className="p-4 bg-surface/50 border border-border/60 hover:border-primary/20 transition rounded-xl flex flex-col justify-between min-w-0 gap-4"
                  >
                    <div className="flex items-start justify-between min-w-0 gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {friend.avatar ? (
                          <img src={friend.avatar} alt="" loading="lazy" decoding="async" className="w-10 h-10 rounded-full object-cover shadow border border-border/40 flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-surface-elevated border border-border flex items-center justify-center flex-shrink-0">
                            <Users className="w-5 h-5 text-accent" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <Link href={`/@${friend.username}`}>
                            <span className="font-bold text-text text-sm hover:underline cursor-pointer block truncate">
                              {friend.displayName}
                            </span>
                          </Link>
                          <span className="text-[10px] text-muted block mt-0.5">@{friend.username}</span>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold rounded flex-shrink-0">
                        {friend.tasteMatch}% Match
                      </span>
                    </div>

                    {/* Active listening status */}
                    {friend.currentActivity ? (
                      <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg flex items-center gap-3 min-w-0">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-ping flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <span className="text-[9px] uppercase tracking-wider text-primary font-bold block">Listening Now</span>
                          <span className="text-xs font-semibold text-text truncate block mt-0.5">{friend.currentActivity.song.title}</span>
                          <span className="text-[10px] text-muted truncate block">{friend.currentActivity.song.artist}</span>
                        </div>
                      </div>
                    ) : friend.isOnline ? (
                      <div className="p-3 bg-primary/5 border border-primary/10 rounded-lg flex items-center gap-2.5 min-w-0">
                        <span className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                        <span className="text-xs font-semibold text-text">Online</span>
                      </div>
                    ) : (
                      <div className="text-[10px] text-muted italic p-2 border border-border/10 rounded-lg bg-surface-elevated/20 truncate">
                        Currently offline
                      </div>
                    )}

                    <div className="flex items-center gap-2 border-t border-border/20 pt-3">
                      <button
                        disabled={actionLoading === friend.id + "-blend"}
                        onClick={() => handleCreateBlend(friend.id)}
                        className="flex-1 py-1.5 bg-accent hover:bg-accent/80 text-text text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-primary" />
                        Create Blend
                      </button>
                      <button
                        onClick={() => setSharingTarget(friend)}
                        className="px-3 py-1.5 border border-border hover:bg-surface-elevated text-muted hover:text-primary rounded-lg transition cursor-pointer"
                        title="Send message/song"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                      <button
                        disabled={actionLoading === friend.id}
                        onClick={() => handleRemove(friend.id)}
                        className="px-3 py-1.5 border border-border hover:bg-red-500/10 hover:text-red-400 text-xs font-semibold rounded-lg transition cursor-pointer"
                        title="Remove member"
                      >
                        <UserMinus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column: Notification History */}
        <div className="lg:col-span-4 space-y-6 min-w-0">
          <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-4 min-w-0">
            <div className="flex items-center justify-between border-b border-border/20 pb-2">
              <h3 className="font-editorial text-lg text-text font-bold">
                Circle Alerts
              </h3>
              {notifications.length > 0 && (
                <button
                  onClick={handleDeleteAllNotifications}
                  className="px-2 py-1 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold cursor-pointer"
                  title="Permanently Delete All Alerts"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete All
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <p className="text-xs text-muted italic">No notifications logs recorded.</p>
            ) : (
              <div className="space-y-3.5 max-h-[400px] overflow-y-auto pr-1">
                {notifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={`flex items-start gap-3 text-xs leading-relaxed p-2.5 rounded-xl border transition ${
                      notif.read ? "bg-transparent border-transparent text-muted" : "bg-primary/5 border-primary/10 text-text"
                    }`}
                  >
                    {notif.senderAvatar ? (
                      <img src={notif.senderAvatar} alt="" loading="lazy" decoding="async" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-surface border border-border flex items-center justify-center flex-shrink-0">
                        <Users className="w-3.5 h-3.5 text-accent" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-text block truncate">{notif.senderName}</span>
                      <div className="block text-[10px] text-muted mt-0.5">
                        {notif.type === "friend_request" && "invited you into their Circle."}
                        {notif.type === "accepted" && "accepted your Circle invitation."}
                        {notif.type === "memory_shared" && (notif.message || "shared a memory.")}
                        {notif.type === "chat_message" && (notif.message || "sent you a message.")}
                        {notif.type === "song_shared" && (
                          <div className="space-y-1.5 mt-1">
                            <span className="block">{notif.message}</span>
                            {notif.song && (
                              <div className="p-2 bg-surface border border-border/40 rounded-lg flex items-center gap-2 min-w-0">
                                <img 
                                  src={notif.song.thumbnail} 
                                  alt="" 
                                  className="w-8 h-8 rounded object-cover flex-shrink-0" 
                                />
                                <div className="min-w-0 flex-1">
                                  <span className="text-[10px] text-text font-semibold block truncate leading-snug">
                                    {notif.song.title}
                                  </span>
                                  <span className="text-[9px] text-muted block truncate">
                                    {notif.song.artist}
                                  </span>
                                </div>
                                <button
                                  onClick={() => playSong(notif.song, [notif.song])}
                                  className="p-1 bg-primary text-white rounded-full hover:scale-105 transition flex-shrink-0 cursor-pointer"
                                  title="Play song"
                                >
                                  <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
      </div>
      </div>
      {sharingTarget && renderShareModal()}
    </div>
  );
}

const LocalLoader2 = ({ className }: { className?: string }) => (
  <svg
    className={`animate-spin ${className}`}
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);
