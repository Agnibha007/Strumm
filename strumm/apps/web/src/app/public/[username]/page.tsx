"use client";

import { useEffect, useState, use } from "react";
import { apiUrl } from "web/lib/api";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useAuthStore } from "web/store/useAuthStore";
import SongArtwork from "web/components/SongArtwork";
import SoundDNAChart from "web/components/SoundDNAChart";
import { Loader2, Music, Sparkles, Heart, ShieldAlert, Play, ArrowRight, Share2, Award } from "lucide-react";
import Link from "next/link";

interface PublicProfileData {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  theme: string;
  soundDNA: {
    energy: number;
    discovery: number;
    nostalgia: number;
    variety: number;
    repeatRate: number;
  };
  totalMinutes: number;
  topArtists: Array<{
    artist: string;
    thumbnail: string;
    count: number;
  }>;
  playlists: Array<{
    id: string;
    name: string;
    description?: string;
    songs: any[];
    followers: number;
  }>;
  memories: Array<{
    id: string;
    song: any;
    note: string;
    date: string;
    reactions?: {
      [key: string]: string[];
    };
  }>;
  badges?: Array<{
    id: string;
    title: string;
    description: string;
    icon?: string;
    earnedAt?: string;
  }>;
  createdAt?: string;
}

export default function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const { playSong } = usePlayerStore();
  const { token, user: currentUser } = useAuthStore();
  
  const [data, setData] = useState<PublicProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tasteMatch, setTasteMatch] = useState<{
    percentage: number;
    commonArtists: string[];
    commonSongs: string[];
    sharedMoods: string[];
  } | null>(null);

  const [circleStatus, setCircleStatus] = useState<"none" | "pending" | "accepted" | "blocked">("none");
  const [isRequester, setIsRequester] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);

  // Decode the URL encoded @ sign if NextJS leaves it
  const cleanUsername = typeof username === "string" ? decodeURIComponent(username).replace(/^@/, "") : "";

  useEffect(() => {
    if (!cleanUsername) return;

    const fetchProfile = async () => {
      try {
        const response = await fetch(apiUrl(`/public/${cleanUsername}`));
        const json = await response.json();
        if (json.success && json.data) {
          setData(json.data);
          
          // If we have a logged in user and this is not our own profile, fetch taste match
          if (token && currentUser && currentUser.username !== cleanUsername) {
            const matchResp = await fetch(apiUrl(`/users/${json.data.id}/taste-match`), {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const matchJson = await matchResp.json();
            if (matchJson.success && matchJson.data) {
              setTasteMatch(matchJson.data);
            }
          }
        } else {
          setError(json.error || "Public profile not found.");
        }
      } catch (e) {
        setError("Network error. Unable to load public profile.");
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [cleanUsername, token, currentUser]);

  useEffect(() => {
    if (!token || !data?.id) return;
    
    const fetchStatus = async () => {
      try {
        const response = await fetch(apiUrl(`/social/status/${data.id}`), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const json = await response.json();
        if (json.success) {
          setCircleStatus(json.status);
          setIsRequester(json.isRequester);
          setRequestId(json.requestId);
        }
      } catch (e) {
        console.error(e);
      }
    };
    
    fetchStatus();
  }, [token, data?.id]);

  const handleSendRequest = async () => {
    if (!token || !data?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/request/${data.id}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setCircleStatus("pending");
        setIsRequester(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSocialLoading(false);
    }
  };

  const handleAcceptRequest = async () => {
    if (!token || !requestId) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/accept/${requestId}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setCircleStatus("accepted");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSocialLoading(false);
    }
  };

  const handleRemoveCircle = async () => {
    if (!token || !data?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/remove/${data.id}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setCircleStatus("none");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSocialLoading(false);
    }
  };

  const handleCreateBlend = async () => {
    if (!token || !data?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/blend/${data.id}`), {
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
      setSocialLoading(false);
    }
  };

  const handleReact = async (memoryId: string, reactionType: string) => {
    if (!token || !currentUser) return;
    try {
      const res = await fetch(apiUrl(`/social/memories/${memoryId}/react`), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reactionType })
      });
      const json = await res.json();
      if (json.success) {
        setData(prev => {
          if (!prev) return null;
          return {
            ...prev,
            memories: prev.memories.map(m => {
              if (m.id === memoryId) {
                const reactions = { ...(m.reactions || {}) };
                const list = reactions[reactionType] ? [...reactions[reactionType]] : [];
                if (!list.includes(currentUser.id)) {
                  list.push(currentUser.id);
                }
                reactions[reactionType] = list;
                return { ...m, reactions };
              }
              return m;
            })
          };
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Resolving user passport...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center max-w-md mx-auto p-6 gap-4">
        <ShieldAlert className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Passport Not Found</h3>
        <p className="text-sm text-muted">{error || "The requested user handle does not exist on Strumm or is set to private."}</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-12 pb-12">
      {/* Profile Passport Header */}
      <div className="flex flex-col md:flex-row items-center md:items-start justify-between gap-6 bg-surface/30 border border-border/60 rounded-3xl p-6 md:p-8 backdrop-blur-md relative overflow-hidden">
        <div className="flex flex-col md:flex-row items-center gap-6 z-10 text-center md:text-left">
          {data.avatar ? (
            <img src={data.avatar} alt={data.displayName} loading="lazy" decoding="async" className="w-24 h-24 rounded-full object-cover border border-border shadow-lg" />
          ) : (
            <div className="w-24 h-24 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
              <Music className="w-10 h-10 text-accent opacity-50" />
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center justify-center md:justify-start gap-2">
              <h2 className="text-3xl font-editorial font-bold text-text">{data.displayName}</h2>
              {data.totalMinutes > 500 && (
                <span title="Elite Listener badge">
                  <Award className="w-5 h-5 text-primary" />
                </span>
              )}
            </div>
            <p className="text-sm text-muted">@{data.username}</p>
            <p className="text-xs text-muted/65 mt-2">
              Listening Passport • Active since {data.createdAt ? new Date(data.createdAt).toLocaleDateString() : "2026"}
            </p>
            
            {/* Circle Action Buttons */}
            {token && currentUser && currentUser.username !== cleanUsername && (
              <div className="flex flex-wrap items-center gap-2 mt-4 justify-center md:justify-start">
                {circleStatus === "none" && (
                  <button
                    disabled={socialLoading}
                    onClick={handleSendRequest}
                    className="px-4 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg transition cursor-pointer"
                  >
                    Add to Circle
                  </button>
                )}
                {circleStatus === "pending" && isRequester && (
                  <span className="px-4 py-1.5 bg-surface-elevated text-muted text-xs font-semibold rounded-lg border border-border/40 select-none">
                    Pending Acceptance
                  </span>
                )}
                {circleStatus === "pending" && !isRequester && (
                  <button
                    disabled={socialLoading}
                    onClick={handleAcceptRequest}
                    className="px-4 py-1.5 bg-accent hover:bg-accent/80 text-text text-xs font-semibold rounded-lg transition cursor-pointer"
                  >
                    Accept Invitation
                  </button>
                )}
                {circleStatus === "accepted" && (
                  <>
                    <span className="px-4 py-1.5 bg-primary/10 border border-primary/20 text-primary text-xs font-semibold rounded-lg select-none">
                      In your Circle
                    </span>
                    <button
                      disabled={socialLoading}
                      onClick={handleCreateBlend}
                      className="px-4 py-1.5 bg-accent hover:bg-accent/80 text-text text-xs font-semibold rounded-lg transition cursor-pointer flex items-center gap-1.5"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Create Blend Mix
                    </button>
                    <button
                      disabled={socialLoading}
                      onClick={handleRemoveCircle}
                      className="px-3 py-1.5 border border-border hover:bg-red-500/10 hover:text-red-400 text-xs font-semibold rounded-lg transition cursor-pointer"
                    >
                      Leave Circle
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Listening Overview */}
        <div className="flex gap-8 text-center z-10">
          <div>
            <div className="text-xs text-muted uppercase tracking-widest font-semibold mb-1">Minutes</div>
            <div className="font-editorial text-3xl font-bold text-text">{data.totalMinutes}</div>
          </div>
          <div className="w-px bg-border/40" />
          <div>
            <div className="text-xs text-muted uppercase tracking-widest font-semibold mb-1">Playlists</div>
            <div className="font-editorial text-3xl font-bold text-text">{data.playlists.length}</div>
          </div>
        </div>
      </div>

      {/* Social Taste Match */}
      {tasteMatch && (
        <div className="bg-gradient-to-r from-primary/10 to-accent/5 border border-primary/20 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
                Social Taste Match
              </span>
              <h3 className="font-editorial text-xl font-bold text-text mt-0.5">
                How aligned is your sound?
              </h3>
            </div>
            <div className="text-right">
              <span className="font-editorial text-3xl font-bold text-primary">{tasteMatch.percentage}%</span>
              <span className="text-xs text-muted block">Match</span>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 border-t border-border/20 pt-4 text-sm text-muted">
            {tasteMatch.commonArtists.length > 0 && (
              <div className="space-y-1">
                <span className="text-xs text-text font-bold">Shared Artists</span>
                <p>{tasteMatch.commonArtists.join(", ")}</p>
              </div>
            )}
            {tasteMatch.sharedMoods.length > 0 && (
              <div className="space-y-1">
                <span className="text-xs text-text font-bold">Vibe Compatibility</span>
                <p className="text-primary font-medium">{tasteMatch.sharedMoods.join(" • ")}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {data.badges && data.badges.length > 0 && (
        <div className="bg-surface/30 border border-border/60 rounded-xl p-6 space-y-4 mb-8">
          <div>
            <h3 className="font-editorial text-xl text-text font-bold">Unlocked Badges</h3>
            <p className="text-xs text-muted">Special milestones earned through their listening journey.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
            {data.badges.map((badge: any) => (
              <div
                key={badge.id}
                className="flex items-center gap-3.5 p-3.5 bg-surface-elevated/40 border border-border/30 rounded-xl shadow-sm"
              >
                <div className="text-3xl p-2 bg-background border border-border/40 rounded-xl shadow-inner select-none">
                  {badge.icon || "🏆"}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-text truncate">
                    {badge.title}
                  </div>
                  <div className="text-[11px] text-muted leading-relaxed mt-0.5">
                    {badge.description}
                  </div>
                  {badge.earnedAt && (
                    <div className="text-[9px] text-primary/70 font-mono mt-1">
                      Earned {new Date(badge.earnedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 font-sans">
        {/* Sound DNA */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-6">
          <div>
            <h3 className="font-editorial text-xl text-text font-bold">Sound DNA</h3>
            <p className="text-xs text-muted">Acoustic blueprints calculated from history.</p>
          </div>
          <SoundDNAChart soundDNA={data.soundDNA} />
        </div>

        {/* Top Artists */}
        <div className="bg-surface/30 border border-border/60 rounded-2xl p-6 space-y-4">
          <div>
            <h3 className="font-editorial text-xl text-text font-bold">Heavy Rotation</h3>
            <p className="text-xs text-muted">Favorite artists in highest play frequencies.</p>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {data.topArtists.slice(0, 4).map((artist, idx) => (
              <div key={artist.artist} className="flex items-center justify-between p-2.5 bg-surface-elevated/40 border border-border/40 rounded-xl">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-muted">0{idx + 1}</span>
                  {artist.thumbnail ? (
                    <img src={artist.thumbnail} alt={artist.artist} loading="lazy" decoding="async" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-surface-elevated border border-border flex items-center justify-center">
                      <Music className="w-4 h-4 text-accent" />
                    </div>
                  )}
                  <span className="text-sm font-semibold text-text">{artist.artist}</span>
                </div>
                <span className="text-xs text-muted">{artist.count} plays</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Public Playlists */}
      {data.playlists.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-editorial text-xl text-text font-bold">Public Playlists</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.playlists.map((playlist) => (
              <Link href={`/playlist/${playlist.id}`} key={playlist.id}>
                <span className="block p-5 bg-surface/30 hover:bg-surface-elevated/40 border border-border/60 rounded-2xl cursor-pointer transition">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-bold text-text truncate">{playlist.name}</h4>
                    <ArrowRight className="w-4 h-4 text-muted hover:text-primary transition" />
                  </div>
                  {playlist.description && (
                    <p className="text-xs text-muted line-clamp-2 mb-4 leading-relaxed">{playlist.description}</p>
                  )}
                  <div className="text-[10px] text-muted uppercase tracking-wider font-semibold">
                    {playlist.songs.length} Tracks • {playlist.followers} Followers
                  </div>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Song Memories */}
      {data.memories.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-editorial text-xl text-text font-bold">Song Memories</h3>
          <div className="space-y-4">
            {data.memories.map((memory) => (
              <div key={memory.id} className="p-5 bg-surface/20 border border-border/50 rounded-2xl space-y-4">
                <div className="flex items-start gap-4">
                  <SongArtwork song={memory.song} className="w-12 h-12 rounded shadow flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-text truncate">{memory.song.title}</h4>
                      <span className="text-xs text-muted">•</span>
                      <p className="text-xs text-muted truncate">{memory.song.artist}</p>
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      Attached on {new Date(memory.date).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => playSong(memory.song, [memory.song])}
                    className="p-2 bg-primary hover:bg-primary-hover text-white rounded-full transition shadow-md"
                    title="Play track"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                </div>
                <div className="p-4 bg-surface-elevated/40 border-l-2 border-primary rounded-r-xl italic text-sm text-text font-serif leading-relaxed">
                  &ldquo;{memory.note}&rdquo;
                </div>
                
                {/* Reactions list & interaction */}
                {token && currentUser && (
                  <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border/20">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted mr-1">React:</span>
                    {[
                      { type: "heart", emoji: "❤️" },
                      { type: "sparkles", emoji: "✨" },
                      { type: "thumbsup", emoji: "👍" }
                    ].map(({ type, emoji }) => {
                      const users = memory.reactions?.[type] || [];
                      const hasReacted = users.includes(currentUser.id);
                      const count = users.length;
                      return (
                        <button
                          key={type}
                          onClick={() => handleReact(memory.id, type)}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition cursor-pointer select-none border ${
                            hasReacted
                              ? "bg-primary/10 border-primary/30 text-primary"
                              : "bg-surface-elevated/40 border-border/40 hover:border-primary/30 text-muted hover:text-text"
                          }`}
                        >
                          <span>{emoji}</span>
                          {count > 0 && <span className="font-semibold font-mono">{count}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
