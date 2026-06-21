"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { apiUrl } from "web/lib/api";
import { Users, Music, Play, Radio, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePlayerStore } from "web/store/usePlayerStore";

interface FriendActivity {
  id: string;
  displayName: string;
  username: string;
  avatar?: string;
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
  const { token, user } = useAuthStore();
  const { playSong } = usePlayerStore();
  const [friends, setFriends] = useState<FriendActivity[]>([]);
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  const [loading, setLoading] = useState(true);

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
      // Poll every 30 seconds to keep live listening activity updated
      const interval = setInterval(fetchActivity, 30000);
      return () => clearInterval(interval);
    }
  }, [token]);

  const hasActivity = token && friends.length > 0;

  useEffect(() => {
    if (onActiveChange) {
      onActiveChange(!!hasActivity);
    }
  }, [hasActivity, onActiveChange]);

  if (!hasActivity) return null;

  if (isCollapsed) {
    return (
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
            return (
              <div key={friend.id} className="relative group cursor-pointer">
                {friend.avatar ? (
                  <img 
                    src={friend.avatar} 
                    alt={friend.displayName} 
                    loading="lazy" 
                    decoding="async" 
                    className={`w-9 h-9 rounded-full object-cover border transition ${
                      hasSong ? "border-green-500 animate-pulse" : "border-border"
                    }`} 
                  />
                ) : (
                  <div className={`w-9 h-9 rounded-full bg-surface-elevated flex items-center justify-center border transition ${
                    hasSong ? "border-green-500 animate-pulse" : "border-border"
                  }`}>
                    <Music className="w-4 h-4 text-accent" />
                  </div>
                )}
                {hasSong && (
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border border-background rounded-full" />
                )}
                
                {/* Tooltip on hover */}
                <div className="absolute right-12 top-1/2 -translate-y-1/2 bg-surface-elevated border border-border px-3 py-2 rounded-xl shadow-2xl opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-200 whitespace-nowrap z-50 text-left min-w-[180px]">
                  <div className="text-xs font-bold text-text">{friend.displayName}</div>
                  <div className="text-[9px] text-muted">@{friend.username}</div>
                  {hasSong ? (
                    <div className="mt-1.5 border-t border-border/20 pt-1.5 flex items-center gap-1.5">
                      <img 
                        src={friend.currentActivity!.song.thumbnail} 
                        className="w-6 h-6 rounded object-cover" 
                        alt="" 
                      />
                      <div className="min-w-0">
                        <div className="text-[9px] font-bold text-text truncate leading-snug">{friend.currentActivity!.song.title}</div>
                        <div className="text-[8px] text-muted truncate">{friend.currentActivity!.song.artist}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[9px] text-muted italic mt-1 font-sans">Offline</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
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
                <div className="flex items-center gap-2.5 min-w-0">
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
                  {hasSongActivity && (
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0 animate-pulse" />
                  )}
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
                ) : (
                  <span className="text-[9px] text-muted block italic px-1">Offline</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
