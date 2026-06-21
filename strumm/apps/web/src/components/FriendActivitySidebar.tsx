"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { apiUrl } from "web/lib/api";
import { Users, Music, Play, Radio, Loader2, ChevronLeft, ChevronRight, Send, X } from "lucide-react";
import Link from "next/link";
import { usePlayerStore } from "web/store/usePlayerStore";

interface FriendActivity {
  id: string;
  displayName: string;
  username: string;
  avatar?: string;
  isOnline?: boolean;
  currentActivity?: {
    song: {
      videoId: string;
      title: string;
      artist: string;
      thumbnail: string;
    };
    timestamp?: string;
  } | null;
}

interface ActiveRoom {
  id: string;
  name: string;
  hostId: string;
}

interface FriendActivitySidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onActiveChange?: (active: boolean) => void;
}

export default function FriendActivitySidebar({
  isCollapsed,
  onToggleCollapse,
  onActiveChange
}: FriendActivitySidebarProps) {
  const { token } = useAuthStore();
  const { playSong, currentSong } = usePlayerStore();
  const [friends, setFriends] = useState<FriendActivity[]>([]);
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  const [loading, setLoading] = useState(true);

  // Message & Song Share States
  const [sharingTarget, setSharingTarget] = useState<FriendActivity | null>(null);
  const [shareMessage, setShareMessage] = useState("");
  const [includeSong, setIncludeSong] = useState(true);
  const [sendingShare, setSendingShare] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const fetchActivity = async () => {
    if (!token) return;
    try {
      const fResp = await fetch(apiUrl("/social/circle"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const fJson = await fResp.json();
      if (fJson.success) {
        setFriends(fJson.data || []);
      }

      const rResp = await fetch(apiUrl("/social/rooms"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const rJson = await rResp.json();
      if (rJson.success) {
        setActiveRooms(rJson.data || []);
      }
    } catch (e) {
      console.warn("Offline or failed to fetch circle activity.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchActivity();
      // Poll every 8 seconds to keep live listening activity updated
      const interval = setInterval(fetchActivity, 8000);
      return () => clearInterval(interval);
    }
  }, [token]);

  const hasActivity = token && friends.length > 0;

  useEffect(() => {
    if (onActiveChange) {
      onActiveChange(!!hasActivity);
    }
  }, [hasActivity, onActiveChange]);

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

  if (!hasActivity) return null;

  if (isCollapsed) {
    return (
      <>
        <aside className="w-16 border-l border-border/60 bg-surface/20 hidden xl:flex flex-col h-screen fixed right-0 top-0 pt-6 pb-20 px-2 z-20 backdrop-blur-md items-center transition-all duration-300">
          {/* Toggle button to expand */}
          <button
            onClick={onToggleCollapse}
            className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg border border-border/40 transition mb-6 cursor-pointer"
            title="Expand Activity"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="w-full flex flex-col items-center gap-4 overflow-y-auto scrollbar-none">
            {friends.map((friend) => {
              const hasSong = !!friend.currentActivity?.song;
              const isOnline = friend.isOnline;
              return (
                <div key={friend.id} className="relative group cursor-pointer">
                  {friend.avatar ? (
                    <img 
                      src={friend.avatar} 
                      alt={friend.displayName} 
                      loading="lazy" 
                      decoding="async" 
                      className={`w-9 h-9 rounded-full object-cover border transition ${
                        hasSong 
                          ? "border-green-500 animate-pulse" 
                          : isOnline 
                            ? "border-green-500/50" 
                            : "border-border"
                      }`} 
                    />
                  ) : (
                    <div className={`w-9 h-9 rounded-full bg-surface-elevated flex items-center justify-center border transition ${
                      hasSong 
                        ? "border-green-500 animate-pulse" 
                        : isOnline 
                          ? "border-green-500/50" 
                          : "border-border"
                    }`}>
                      <Music className="w-4 h-4 text-accent" />
                    </div>
                  )}
                  {(hasSong || isOnline) && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border border-background rounded-full" />
                  )}
                  
                  {/* Tooltip on hover with interactive trigger */}
                  <div className="absolute right-12 top-1/2 -translate-y-1/2 bg-surface-elevated border border-border px-3 py-2.5 rounded-xl shadow-2xl opacity-0 group-hover:opacity-100 group-hover:pointer-events-auto pointer-events-none transition-all duration-200 whitespace-nowrap z-50 text-left min-w-[180px]">
                    <div className="flex items-start justify-between gap-4 border-b border-border/20 pb-1.5 mb-1.5">
                      <div>
                        <div className="text-xs font-bold text-text">{friend.displayName}</div>
                        <div className="text-[9px] text-muted">@{friend.username}</div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSharingTarget(friend);
                        }}
                        className="p-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 hover:border-primary/30 rounded transition cursor-pointer"
                        title="Send message/song"
                      >
                        <Send className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    {hasSong ? (
                      <div className="flex items-center gap-1.5">
                        <img 
                          src={friend.currentActivity!.song.thumbnail} 
                          className="w-6 h-6 rounded object-cover" 
                          alt="" 
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[9px] font-bold text-text truncate leading-snug">{friend.currentActivity!.song.title}</div>
                          <div className="text-[8px] text-muted truncate">{friend.currentActivity!.song.artist}</div>
                        </div>
                      </div>
                    ) : isOnline ? (
                      <div className="text-[9px] text-green-500 font-semibold font-sans">Online</div>
                    ) : (
                      <div className="text-[9px] text-muted italic font-sans">Offline</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Modal display portal */}
        {sharingTarget && renderShareModal()}
      </>
    );
  }

  function renderShareModal() {
    if (!sharingTarget) return null;
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
  }

  return (
    <>
      <aside className="w-80 border-l border-border/60 bg-surface/20 hidden xl:flex flex-col h-screen fixed right-0 top-0 pt-6 pb-20 px-5 z-20 backdrop-blur-md overflow-y-auto transition-all duration-300">
        <div className="flex items-center justify-between border-b border-border/20 pb-4 mb-4 gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            <h3 className="font-editorial text-sm uppercase tracking-wider text-text font-bold">Circle Activity</h3>
          </div>
          <button
            onClick={onToggleCollapse}
            className="p-1.5 hover:bg-surface-elevated text-muted hover:text-text rounded-lg border border-transparent hover:border-border transition cursor-pointer"
            title="Collapse Activity"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-xs text-muted">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span>Syncing circle waves...</span>
          </div>
        ) : (
          <div className="space-y-4">
            {friends.map((friend) => {
              const hasSongActivity = !!friend.currentActivity?.song;
              const userRoom = activeRooms.find(r => r.hostId === friend.id);

              return (
                <div key={friend.id} className="p-3 bg-surface-elevated/20 border border-border/40 rounded-xl space-y-3 min-w-0 transition hover:border-primary/20">
                  <div className="flex items-center justify-between gap-2.5 min-w-0">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {friend.avatar ? (
                        <img src={friend.avatar} alt="" loading="lazy" decoding="async" className="w-7 h-7 rounded-full object-cover flex-shrink-0 border border-border" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-surface-elevated flex items-center justify-center flex-shrink-0 border border-border">
                          <Music className="w-3.5 h-3.5 text-accent" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <Link href={`/@${friend.username}`}>
                          <span className="text-xs font-bold text-text truncate hover:underline cursor-pointer block">
                            {friend.displayName}
                          </span>
                        </Link>
                        <span className="text-[10px] text-muted truncate block">@{friend.username}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setSharingTarget(friend)}
                        className="p-1 hover:bg-surface-elevated text-muted hover:text-primary rounded transition cursor-pointer"
                        title="Send message/song"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                      {hasSongActivity ? (
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0 animate-pulse" />
                      ) : friend.isOnline ? (
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0" />
                      ) : null}
                    </div>
                  </div>

                  {hasSongActivity ? (
                    <div className="space-y-2">
                      <div className="p-2 bg-primary/5 border border-primary/10 rounded-lg flex items-center gap-2 min-w-0">
                        <img 
                          src={friend.currentActivity!.song.thumbnail} 
                          alt="" 
                          loading="lazy"
                          decoding="async"
                          className="w-8 h-8 rounded object-cover flex-shrink-0" 
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-[10px] text-text font-semibold block truncate leading-snug">
                            {friend.currentActivity!.song.title}
                          </span>
                          <span className="text-[9px] text-muted block truncate">
                            {friend.currentActivity!.song.artist}
                          </span>
                        </div>
                        <button
                          onClick={() => playSong(friend.currentActivity!.song as any, [friend.currentActivity!.song as any])}
                          className="p-1.5 bg-primary text-white rounded-full hover:scale-105 transition flex-shrink-0 cursor-pointer"
                          title="Listen along"
                        >
                          <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
                        </button>
                      </div>

                      {userRoom && (
                        <Link href={`/rooms/${userRoom.id}`} className="block">
                          <span className="w-full py-1 bg-accent/25 hover:bg-accent/40 border border-accent/30 text-accent text-[9px] uppercase tracking-wider font-bold rounded flex items-center justify-center gap-1.5 transition cursor-pointer">
                            <Radio className="w-3 h-3 text-primary" />
                            Join Strumm Room
                          </span>
                        </Link>
                      )}
                    </div>
                  ) : friend.isOnline ? (
                    <span className="text-[9px] text-green-500 font-semibold block px-1">Online</span>
                  ) : (
                    <span className="text-[9px] text-muted block italic px-1">Offline</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </aside>

      {/* Modal display portal */}
      {sharingTarget && renderShareModal()}
    </>
  );
}
