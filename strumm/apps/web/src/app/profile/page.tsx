"use client";

import { useEffect, useState, Suspense } from "react";
import dynamic from "next/dynamic";
import { useAuthStore } from "web/store/useAuthStore";
import { User as UserIcon, Calendar, Clock, Library, Heart, Star, Award, Sparkles, FolderHeart, LogOut, Trash2, AlertCircle, Loader2, Compass, History, Zap, Disc } from "lucide-react";
import { Playlist } from "@strumm/types";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl } from "web/lib/api";
import { signOut } from "next-auth/react";
import Link from "next/link";
import SongArtwork from "web/components/SongArtwork";

const SoundDNAChart = dynamic(() => import("web/components/SoundDNAChart"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-10 text-muted">
      <Loader2 className="w-5 h-5 animate-spin text-primary" />
    </div>
  ),
});

const DeleteAccountModal = dynamic(
  () => import("./DeleteAccountModal"),
  { ssr: false }
);

function ProfilePageContent() {
  const { token, user: cachedUser, fetchProfile, logout } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const usernameParam = searchParams.get("username");

  const [displayedUser, setDisplayedUser] = useState<any | null>(null);
  const [isOwnProfile, setIsOwnProfile] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [likedCount, setLikedCount] = useState(0);
  const [memories, setMemories] = useState<any[]>([]);

  // Social states for public view
  const [circleStatus, setCircleStatus] = useState<"none" | "pending" | "accepted" | "blocked" | "loading">("none");
  const [isRequester, setIsRequester] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [tasteMatch, setTasteMatch] = useState<any | null>(null);

  // Deletion states
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const loadProfileData = async () => {
    setLoading(true);
    setError(null);
    try {
      const currentUsername = cachedUser?.username;
      const isParamOwn = !usernameParam || (currentUsername && usernameParam.toLowerCase() === currentUsername.toLowerCase());

      if (isParamOwn) {
        setIsOwnProfile(true);
        // Sync fresh profile stats
        await fetchProfile();
        
        // Load playlists and library data
        const libResponse = await fetch(apiUrl("/library"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const libJson = await libResponse.json();
        if (libJson.success && libJson.data) {
          setPlaylists(libJson.data.playlists || []);
          setLikedCount(libJson.data.likedSongsCount || 0);
        }

        // Load user memories
        const memResponse = await fetch(apiUrl("/memories"), {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const memJson = await memResponse.json();
        if (memJson.success && memJson.data) {
          setMemories(memJson.data || []);
        }
      } else {
        setIsOwnProfile(false);
        // Fetch public user
        const res = await fetch(apiUrl(`/users/public/${usernameParam}`));
        const json = await res.json();
        if (!json.success || !json.data) {
          setError(json.error || "Listener not found");
          setDisplayedUser(null);
          return;
        }

        const publicData = json.data;
        setDisplayedUser(publicData);
        // The API returns publicPlaylists or playlists for public users
        setPlaylists(publicData.publicPlaylists || publicData.playlists || []);
        setMemories(publicData.memories || []);
        setLikedCount(publicData.likedCount || 0); // public stats fallback

        // Fetch social status and taste match
        if (token && publicData.id) {
          try {
            const statusResponse = await fetch(apiUrl(`/social/status/${publicData.id}`), {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const statusJson = await statusResponse.json();
            if (statusJson.success) {
              setCircleStatus(statusJson.status);
              setIsRequester(statusJson.isRequester);
              setRequestId(statusJson.requestId);
            }
          } catch (statusError) {
            console.error(statusError);
          }

          try {
            const matchResp = await fetch(apiUrl(`/users/${publicData.id}/taste-match`), {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const matchJson = await matchResp.json();
            if (matchJson.success && matchJson.data) {
              setTasteMatch(matchJson.data);
            }
          } catch (matchError) {
            console.error(matchError);
          }
        }
      }
    } catch (e) {
      console.warn("Unable to fetch complete profile details offline.", e);
      setError("Unable to load profile data.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    setDeletingMemoryId(id);
    try {
      const response = await fetch(apiUrl(`/memories/${id}`), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json();
      if (json.success) {
        setMemories(prev => prev.filter(m => m.id !== id));
      }
    } catch (e) {
      console.error("Failed to delete memory:", e);
    } finally {
      setDeletingMemoryId(null);
    }
  };

  const handleReact = async (memoryId: string, reactionType: string) => {
    if (!token || isOwnProfile) return;
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
        setMemories(prev => prev.map(m => {
          if (m.id === memoryId) {
            const reactions = { ...(m.reactions || {}) };
            const list = reactions[reactionType] ? [...reactions[reactionType]] : [];
            if (cachedUser && !list.includes(cachedUser.id)) {
              list.push(cachedUser.id);
            }
            reactions[reactionType] = list;
            return { ...m, reactions };
          }
          return m;
        }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Clear previous state on navigation
  useEffect(() => {
    setDisplayedUser(null);
    setPlaylists([]);
    setMemories([]);
    setTasteMatch(null);
    setCircleStatus("loading");
    setLoading(true);
    setError(null);

    if (token) {
      loadProfileData();
    }
  }, [usernameParam, token]);

  // Sync state with personal store updates
  useEffect(() => {
    const currentUsername = cachedUser?.username;
    const isParamOwn = !usernameParam || (currentUsername && usernameParam.toLowerCase() === currentUsername.toLowerCase());
    if (isParamOwn && cachedUser) {
      setDisplayedUser({
        id: cachedUser.id,
        username: cachedUser.username,
        displayName: cachedUser.displayName,
        avatar: cachedUser.avatar,
        bio: (cachedUser as any).bio || "",
        createdAt: cachedUser.createdAt,
        soundDNA: (cachedUser as any).soundDNA || null,
        replayHighlights: {
          totalMinutes: Math.round((cachedUser.statistics?.totalListeningTime || 0) / 60),
          monthlyMinutes: Math.round((cachedUser.statistics?.monthlyListeningTime || 0) / 60)
        },
        topArtists: cachedUser.statistics?.topArtists || [],
        topSongs: cachedUser.statistics?.topSongs || [],
        settings: cachedUser.settings
      });
    }
  }, [cachedUser, usernameParam]);

  const handleLogout = () => {
    logout();
    signOut();
  };

  const handleUpdateSetting = async (key: string, value: any) => {
    if (!token || !displayedUser) return;
    const updatedSettings = {
      ...displayedUser.settings,
      [key]: value
    };
    
    setDisplayedUser({
      ...displayedUser,
      settings: updatedSettings
    });

    try {
      await fetch(apiUrl("/profile"), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          settings: updatedSettings
        })
      });
      await fetchProfile();
    } catch (e) {
      console.error("Failed to update user setting:", e);
    }
  };

  const triggerDeleteAccount = async () => {
    setDeleting(true);
    setAccountError(null);
    try {
      const response = await fetch(apiUrl("/profile"), {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.success) {
        logout();
        signOut();
      } else {
        setAccountError(json.error || "Failed to delete account.");
      }
    } catch (e) {
      setAccountError("Unable to connect to backend server to process deletion.");
    } finally {
      setDeleting(false);
      setIsDeleteModalOpen(false);
    }
  };

  const handleSendRequest = async () => {
    if (!token || !displayedUser?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/request/${displayedUser.id}`), {
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
    if (!token || !displayedUser?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/remove/${displayedUser.id}`), {
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
    if (!token || !displayedUser?.id) return;
    setSocialLoading(true);
    try {
      const res = await fetch(apiUrl(`/social/blend/${displayedUser.id}`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success && json.data?.id) {
        router.push(`/playlist/${json.data.id}`);
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

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Resolving user passport...</span>
      </div>
    );
  }

  if (error || !displayedUser) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center max-w-md mx-auto p-6 gap-4">
        <AlertCircle className="w-12 h-12 text-primary opacity-50" />
        <h3 className="font-editorial text-2xl text-text font-bold">Listener Not Found</h3>
        <p className="text-sm text-muted">{error || "The requested user handle does not exist on Strumm or is set to private."}</p>
      </div>
    );
  }

  // Format statistics
  const totalMinutes = displayedUser.replayHighlights?.totalMinutes || 0;
  const monthlyMinutes = displayedUser.replayHighlights?.monthlyMinutes || 0;
  const topArtists = displayedUser.topArtists || [];
  const topSongs = displayedUser.topSongs || [];
  const soundDNA = displayedUser.soundDNA;
  const isDNALoading = loading || !displayedUser || !soundDNA;
  
  // Define all available badges/passport stamps
  const allBadges = [
    { 
      name: "Novice", 
      desc: "Passport activated", 
      icon: UserIcon, 
      earned: true 
    },
    { 
      name: "Melomanist", 
      desc: "First minutes logged", 
      icon: Sparkles, 
      earned: totalMinutes > 0 
    },
    { 
      name: "Audiophile", 
      desc: "Listened over 1 hour", 
      icon: Star, 
      earned: totalMinutes > 60 
    },
    { 
      name: "Power Listener", 
      desc: "Listened over 10 hours", 
      icon: Clock, 
      earned: totalMinutes >= 600 
    },
    { 
      name: "Tastemaker", 
      desc: "Liked 5+ records", 
      icon: Award, 
      earned: likedCount > 5 
    },
    { 
      name: "Collector", 
      desc: "Liked 10+ records", 
      icon: Heart, 
      earned: likedCount >= 10 
    },
    { 
      name: "Curation King", 
      desc: "Created 3+ playlists", 
      icon: FolderHeart, 
      earned: playlists.length > 2 
    },
    { 
      name: "Vibe Architect", 
      desc: "Created 5+ playlists", 
      icon: Disc, 
      earned: playlists.length >= 5 
    },
    { 
      name: "Archivist", 
      desc: "Created 3+ memories", 
      icon: Library, 
      earned: memories.length >= 3 
    },
    { 
      name: "Sonic Explorer", 
      desc: "Variety DNA 8+", 
      icon: Compass, 
      earned: soundDNA ? soundDNA.variety >= 8 : false 
    },
    { 
      name: "Time Traveler", 
      desc: "Nostalgia DNA 8+", 
      icon: History, 
      earned: soundDNA ? soundDNA.nostalgia >= 8 : false 
    },
    { 
      name: "High Voltage", 
      desc: "Energy DNA 8+", 
      icon: Zap, 
      earned: soundDNA ? soundDNA.energy >= 8 : false 
    }
  ];

  const issuedDate = displayedUser.createdAt 
    ? new Date(displayedUser.createdAt).toLocaleDateString() 
    : displayedUser.passport?.createdAt 
      ? new Date(displayedUser.passport.createdAt).toLocaleDateString() 
      : "2026";

  const passportNumber = `№ ST-${((displayedUser.createdAt || "").substring(2, 4)) || "26"}${((displayedUser.id || displayedUser.username || "0000").substring(0, 4)).toUpperCase()}`;

  return (
    <div className="space-y-10 max-w-5xl soft-enter">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Curation Passport
        </span>
        <h2 className="text-3xl sm:text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          {isOwnProfile ? "Strumm Passport" : `${displayedUser.displayName}'s Passport`}
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Premium Physical Passport Card */}
        <div className="lg:col-span-5 bg-surface border border-border/80 rounded-xl overflow-hidden shadow-2xl relative">
          <div className="absolute top-0 left-0 w-full h-[3px] bg-primary box-glow" />
          
          <div className="p-6 text-center space-y-6">
            {/* Stamp Logo */}
            <div className="flex justify-between items-center text-[10px] text-muted tracking-widest uppercase font-bold border-b border-border/20 pb-3 select-none">
              <span>Passport Control</span>
              <span className="text-primary font-mono">{passportNumber}</span>
            </div>

            {/* Photo Avatar */}
            <div className="w-28 h-28 rounded-full bg-surface-elevated overflow-hidden border-2 border-border/80 mx-auto relative shadow-inner">
              {displayedUser.avatar ? (
                <img src={displayedUser.avatar} alt={displayedUser.displayName} loading="lazy" decoding="async" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <UserIcon className="w-10 h-10 text-muted" />
                </div>
              )}
            </div>

            {/* Basic Info */}
            <div className="space-y-1">
              <h3 className="font-editorial text-2xl text-text font-bold leading-tight">
                {displayedUser.displayName}
              </h3>
              <p className="text-xs text-muted">@{displayedUser.username}</p>
              {displayedUser.bio && (
                <p className="text-xs text-muted/80 italic mt-2 max-w-xs mx-auto">
                  &ldquo;{displayedUser.bio}&rdquo;
                </p>
              )}
              <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted/65 mt-2 font-semibold">
                <Calendar className="w-3.5 h-3.5" />
                <span>Issued {issuedDate}</span>
              </div>
            </div>

            {/* Passport Stamps/Badges */}
            <div className="space-y-3 border-t border-border/20 pt-5">
              <h4 className="text-[10px] tracking-wider uppercase text-muted font-bold text-left select-none">
                Passport Stamp Archives
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {allBadges.filter(badge => badge.earned).map((badge, idx) => {
                  const Icon = badge.icon;
                  return (
                    <div
                      key={idx}
                      className={`p-2.5 rounded-lg border transition duration-300 flex items-center gap-2 text-left select-none ${
                        badge.earned
                          ? "bg-surface-elevated border-border/80 text-text"
                          : "bg-surface-elevated/20 border-border/20 text-muted opacity-40 grayscale"
                      }`}
                    >
                      <div className={`p-1.5 rounded flex-shrink-0 border ${
                        badge.earned
                          ? "bg-primary/10 border-primary/20 text-primary"
                          : "bg-muted/5 border-border/20 text-muted"
                      }`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold truncate leading-tight">
                          {badge.name}
                        </div>
                        <div className="text-[8px] truncate mt-0.5 leading-none">
                          {badge.desc}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Circle Action Buttons if Public User */}
            {token && !isOwnProfile && (
              <div className="flex flex-wrap items-center gap-2 mt-4 justify-center border-t border-border/20 pt-5">
                {circleStatus === "none" && (
                  <button
                    disabled={socialLoading}
                    onClick={handleSendRequest}
                    className="w-full px-4 py-2 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg transition cursor-pointer select-none"
                  >
                    {socialLoading ? "Processing..." : "Add to Circle"}
                  </button>
                )}
                {circleStatus === "pending" && isRequester && (
                  <span className="w-full text-center px-4 py-2 bg-surface-elevated text-muted text-xs font-semibold rounded-lg border border-border/40 select-none">
                    Pending Acceptance
                  </span>
                )}
                {circleStatus === "pending" && !isRequester && (
                  <button
                    disabled={socialLoading}
                    onClick={handleAcceptRequest}
                    className="w-full px-4 py-2 bg-accent hover:bg-accent/80 text-text text-xs font-semibold rounded-lg transition cursor-pointer select-none"
                  >
                    {socialLoading ? "Processing..." : "Accept Invitation"}
                  </button>
                )}
                {circleStatus === "accepted" && (
                  <div className="space-y-2.5 w-full">
                    <span className="block text-center px-4 py-2 bg-primary/10 border border-primary/20 text-primary text-xs font-semibold rounded-lg select-none">
                      In your Circle
                    </span>
                    <div className="flex gap-2">
                      <button
                        disabled={socialLoading}
                        onClick={handleCreateBlend}
                        className="flex-1 px-3 py-2 bg-accent hover:bg-accent/80 text-text text-xs font-semibold rounded-lg transition cursor-pointer flex items-center justify-center gap-1.5 select-none"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        Create Blend Mix
                      </button>
                      <button
                        disabled={socialLoading}
                        onClick={handleRemoveCircle}
                        className="px-3 py-2 border border-border hover:bg-red-500/10 hover:text-red-400 text-xs font-semibold rounded-lg transition cursor-pointer select-none"
                      >
                        Leave
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Privacy settings for Own profile */}
            {isOwnProfile && displayedUser.settings && (
              <div className="border-t border-border/20 pt-5 space-y-3">
                <h4 className="text-[10px] tracking-wider uppercase text-muted font-bold text-left select-none">
                  Privacy Controls
                </h4>
                <div className="space-y-3.5 text-left border border-border/40 p-4 rounded-xl bg-surface/30">
                  <div className="flex items-center justify-between text-xs">
                    <div>
                      <span className="font-semibold text-text block">Broadcast Listening Activity</span>
                      <span className="text-[10px] text-muted block mt-0.5">Let Circle members see what song you are playing now.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={displayedUser.settings.showListeningActivity ?? true}
                      onChange={(e) => handleUpdateSetting("showListeningActivity", e.target.checked)}
                      className="w-4 h-4 rounded accent-primary border-border focus:ring-primary focus:ring-offset-background cursor-pointer"
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs border-t border-border/20 pt-3">
                    <div>
                      <span className="font-semibold text-text block">Public Passport Visibility</span>
                      <span className="text-[10px] text-muted block mt-0.5">Allow non-Circle users to view your Strumm Passport.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={displayedUser.settings.publicPassport ?? true}
                      onChange={(e) => handleUpdateSetting("publicPassport", e.target.checked)}
                      className="w-4 h-4 rounded accent-primary border-border focus:ring-primary focus:ring-offset-background cursor-pointer"
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs border-t border-border/20 pt-3">
                    <div>
                      <span className="font-semibold text-text block">Show Top Tracks & Artists</span>
                      <span className="text-[10px] text-muted block mt-0.5">Display listening statistics in your public passport.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={displayedUser.settings.showTopSongs ?? true}
                      onChange={(e) => handleUpdateSetting("showTopSongs", e.target.checked)}
                      className="w-4 h-4 rounded accent-primary border-border focus:ring-primary focus:ring-offset-background cursor-pointer"
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs border-t border-border/20 pt-3">
                    <div>
                      <span className="font-semibold text-text block">Allow Incoming Circle Requests</span>
                      <span className="text-[10px] text-muted block mt-0.5">Let others invite you into their music circle.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={displayedUser.settings.allowRequests ?? true}
                      onChange={(e) => handleUpdateSetting("allowRequests", e.target.checked)}
                      className="w-4 h-4 rounded accent-primary border-border focus:ring-primary focus:ring-offset-background cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Logout/Account settings for Own profile */}
            {isOwnProfile && (
              <div className="border-t border-border/20 pt-5 space-y-3">
                <h4 className="text-[10px] tracking-wider uppercase text-muted font-bold text-left select-none">
                  Account Control
                </h4>
                {accountError && (
                  <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{accountError}</span>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={handleLogout}
                    className="py-2.5 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none"
                  >
                    <LogOut className="w-4 h-4 text-muted" />
                    Sign Out
                  </button>
                  <button
                    onClick={() => {
                      setAccountError(null);
                      setIsDeleteModalOpen(true);
                    }}
                    disabled={deleting}
                    className="py-2.5 bg-primary/10 border border-primary/20 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    {deleting ? "Erasing..." : "Delete Account"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Metrics and Stats */}
        <div className="lg:col-span-7 space-y-8">
          {/* Strumm Replay Call-to-Action */}
          {isOwnProfile ? (
            <Link href="/replay">
              <span className="block bg-gradient-to-r from-primary/10 via-surface/60 to-accent/5 border border-primary/20 rounded-xl p-5 hover:border-primary/40 transition cursor-pointer relative overflow-hidden group">
                <div className="flex justify-between items-center z-10 relative">
                  <div>
                    <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">New Experience</span>
                    <h4 className="font-editorial text-lg text-text font-bold mt-1">Strumm Replay & Sound DNA</h4>
                    <p className="text-xs text-muted mt-1">Explore your listening minutes, top genres, discovery index, and archetypes.</p>
                  </div>
                  <Sparkles className="w-6 h-6 text-primary group-hover:scale-110 transition-transform" />
                </div>
              </span>
            </Link>
          ) : tasteMatch && (
            <div className="bg-gradient-to-r from-primary/10 to-accent/5 border border-primary/20 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
                    Social Taste Match
                  </span>
                  <h3 className="font-editorial text-lg text-text font-bold mt-1">
                    How aligned is your sound?
                  </h3>
                </div>
                <div className="text-right">
                  <span className="font-editorial text-3xl font-bold text-primary">{tasteMatch.percentage}%</span>
                  <span className="text-[9px] text-muted block uppercase font-semibold">Match</span>
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border/20 pt-4 text-xs text-muted leading-relaxed">
                {tasteMatch.commonArtists.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-text font-bold">Shared Artists</span>
                    <p>{tasteMatch.commonArtists.join(", ")}</p>
                  </div>
                )}
                {tasteMatch.sharedMoods.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-text font-bold">Vibe Compatibility</span>
                    <p className="text-primary font-semibold">{tasteMatch.sharedMoods.join(" • ")}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Main stats counters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center hover:-translate-y-0.5 transition-transform">
              <Clock className="w-5 h-5 text-primary mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {totalMinutes}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Total Min
              </div>
            </div>
            
            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center hover:-translate-y-0.5 transition-transform">
              <Calendar className="w-5 h-5 text-accent mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {monthlyMinutes}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Month Min
              </div>
            </div>

            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center hover:-translate-y-0.5 transition-transform">
              <Heart className="w-5 h-5 text-rose-500 mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {isOwnProfile ? likedCount : "-"}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Likes
              </div>
            </div>
          </div>

          {/* Custom Badges / Achievements Section */}
          {displayedUser.badges && displayedUser.badges.length > 0 && (
            <div className="bg-surface/30 border border-border/60 rounded-xl p-6 space-y-4">
              <div>
                <h3 className="font-editorial text-xl text-text font-bold">Unlocked Badges</h3>
                <p className="text-xs text-muted">Special milestones earned through your listening journey.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
                {displayedUser.badges.map((badge: any) => (
                  <div
                    key={badge.id}
                    className="flex items-center gap-3.5 p-3.5 bg-surface-elevated/40 border border-border/30 rounded-xl hover:border-primary/30 transition duration-300 shadow-sm"
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

          {/* Sound DNA component */}
          <div className="bg-surface/30 border border-border/60 rounded-xl p-6 space-y-6">
            <div>
              <h3 className="font-editorial text-xl text-text font-bold">Sound DNA</h3>
              <p className="text-xs text-muted">Acoustic blueprints calculated from history.</p>
            </div>
            {isDNALoading ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-[10px] uppercase tracking-wider">Calculating DNA...</span>
              </div>
            ) : totalMinutes === 0 ? (
              <div className="text-center py-10 text-xs text-muted italic">
                No listening history logged yet. Play tracks to generate your Sound DNA.
              </div>
            ) : (
              <SoundDNAChart soundDNA={soundDNA} />
            )}
          </div>

          {/* Top Artists section */}
          <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              Top Sound Architects
            </h3>
            {topArtists.length === 0 ? (
              <p className="text-xs text-muted italic">No listening minutes logged yet. Play tracks to populate stats.</p>
            ) : (
              <div className="divide-y divide-border/20 font-sans">
                {topArtists.map((artist: any, idx: number) => (
                  <div key={idx} className="flex justify-between items-center py-2.5 first:pt-0 last:pb-0 text-xs">
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-primary font-mono w-4">{idx + 1}</span>
                      <span className="font-semibold text-text">{artist.name || artist.artist}</span>
                    </div>
                    <span className="text-muted font-semibold">{artist.playCount || artist.count || 0} plays</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top Songs section */}
          {topSongs.length > 0 && (
            <div className="bg-surface border border-border/60 rounded-xl p-6 space-y-4">
              <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
                Heavy Rotation Tracks
              </h3>
              <div className="divide-y divide-border/20 font-sans">
                {topSongs.map((song: any, idx: number) => (
                  <div key={idx} className="flex justify-between items-center py-2.5 first:pt-0 last:pb-0 text-xs">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-bold text-primary font-mono w-4 flex-shrink-0">{idx + 1}</span>
                      {song.image && (
                        <img src={song.image} alt={song.title} loading="lazy" decoding="async" className="w-7 h-7 rounded object-cover flex-shrink-0" />
                      )}
                      <div className="text-left min-w-0">
                        <span className="font-semibold text-text block truncate leading-tight">{song.title}</span>
                        <span className="text-[10px] text-muted truncate">{song.artist}</span>
                      </div>
                    </div>
                    <span className="text-muted font-semibold flex-shrink-0">{song.plays || song.playCount || 0} plays</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Playlists grid */}
          <div className="space-y-4">
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              {isOwnProfile ? "Curator Folder Archives" : "Public Playlists"}
            </h3>
            {playlists.length === 0 ? (
              <p className="text-xs text-muted italic">No playlists created yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {playlists.map((playlist) => (
                  <Link
                    key={playlist.id}
                    href={`/playlist/${playlist.id}`}
                    className="p-3.5 bg-surface/40 hover:bg-surface border border-border/40 hover:border-border/80 rounded-xl flex items-center justify-between transition group cursor-pointer"
                  >
                    <div>
                      <div className="font-editorial text-base text-text font-bold leading-tight group-hover:text-primary transition">
                        {playlist.name}
                      </div>
                      <div className="text-xs text-muted mt-1">{(playlist.songs || []).length} records</div>
                    </div>
                    <div className="p-2 bg-surface-elevated rounded-lg border border-border/40 text-muted group-hover:text-primary transition">
                      <Library className="w-4 h-4" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Song Memories List */}
          <div className="space-y-4">
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              Song Memories
            </h3>
            {memories.length === 0 ? (
              <p className="text-xs text-muted italic">No emotional memories attached to songs yet.</p>
            ) : (
              <div className="space-y-4">
                {memories.map((memory) => (
                  <div key={memory.id} className="p-4 bg-surface/40 border border-border/60 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <SongArtwork song={memory.song} className="w-8 h-8 rounded flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-text truncate leading-tight">{memory.song.title}</div>
                          <div className="text-[10px] text-muted truncate">{memory.song.artist}</div>
                        </div>
                      </div>
                      {isOwnProfile ? (
                        <button
                          onClick={() => handleDeleteMemory(memory.id)}
                          disabled={deletingMemoryId === memory.id}
                          className="p-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-[10px] transition cursor-pointer disabled:opacity-30"
                        >
                          Delete
                        </button>
                      ) : (
                        token && (
                          <div className="flex items-center gap-1.5">
                            {[
                              { type: "heart", emoji: "❤️" },
                              { type: "sparkles", emoji: "✨" },
                              { type: "thumbsup", emoji: "👍" }
                            ].map(({ type, emoji }) => {
                              const users = memory.reactions?.[type] || [];
                              const hasReacted = cachedUser && users.includes(cachedUser.id);
                              const count = users.length;
                              return (
                                <button
                                  key={type}
                                  onClick={() => handleReact(memory.id, type)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition cursor-pointer select-none ${
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
                        )
                      )}
                    </div>
                    <div className="p-3 bg-surface-elevated/40 border-l-2 border-accent rounded-r-lg italic text-xs text-text leading-relaxed font-serif">
                      &ldquo;{memory.note}&rdquo;
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <DeleteAccountModal
        isOpen={isDeleteModalOpen}
        deleting={deleting}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={triggerDeleteAccount}
      />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs uppercase tracking-widest">Resolving user passport...</span>
      </div>
    }>
      <ProfilePageContent />
    </Suspense>
  );
}
