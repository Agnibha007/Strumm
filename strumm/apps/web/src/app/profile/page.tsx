"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { User as UserIcon, Calendar, Clock, Library, Heart, Star, Award, Sparkles, FolderHeart, LogOut, Trash2, AlertCircle, X } from "lucide-react";
import { Playlist, User } from "@strumm/types";
import { useRouter } from "next/navigation";
import { apiUrl } from "web/lib/api";
import { signOut } from "next-auth/react";
import { AnimatePresence, motion } from "framer-motion";

export default function ProfilePage() {
  const { token, user: cachedUser, fetchProfile, logout } = useAuthStore();
  const router = useRouter();
  
  const [profileUser, setProfileUser] = useState<User | null>(cachedUser);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [likedCount, setLikedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteConfirmationInput, setDeleteConfirmationInput] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);

  const loadProfileAndLibrary = async () => {
    setLoading(true);
    try {
      // 1. Sync fresh user profile stats
      await fetchProfile();
      
      // 2. Load playlists and library data
      const libResponse = await fetch(apiUrl("/library"), {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const libJson = await libResponse.json();
      if (libJson.success && libJson.data) {
        setPlaylists(libJson.data.playlists || []);
        setLikedCount(libJson.data.likedSongsCount || 0);
      }
    } catch (e) {
      console.warn("Unable to fetch complete profile details offline.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      loadProfileAndLibrary();
    }
  }, [token]);

  // Sync state with store updates
  useEffect(() => {
    if (cachedUser) {
      setProfileUser(cachedUser);
    }
  }, [cachedUser]);

  const handleLogout = () => {
    logout();
    signOut();
  };

  const triggerDeleteAccount = async () => {
    if (deleteConfirmationInput.trim().toUpperCase() !== "DELETE") {
      setAccountError("Please type DELETE to confirm account deletion.");
      return;
    }

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
      setDeleteConfirmationInput("");
      setIsDeleteModalOpen(false);
    }
  };

  if (!profileUser) return null;

  // Format statistics
  const totalMinutes = Math.round((profileUser.statistics?.totalListeningTime || 0) / 60);
  const monthlyMinutes = Math.round((profileUser.statistics?.monthlyListeningTime || 0) / 60);
  const topArtists = profileUser.statistics?.topArtists || [];
  
  // Custom badges based on listening stats
  const badges = [];
  if (totalMinutes > 0) badges.push({ name: "Melomanist", desc: "First minutes logged", icon: Sparkles });
  if (totalMinutes > 60) badges.push({ name: "Audiophile", desc: "Listened over 1 hour", icon: Star });
  if (likedCount > 5) badges.push({ name: "Tastemaker", desc: "Liked 5+ records", icon: Award });
  if (playlists.length > 2) badges.push({ name: "Curation King", desc: "Created 3+ custom playlists", icon: FolderHeart });
  if (badges.length === 0) badges.push({ name: "Novice", desc: "Passport activated", icon: UserIcon });

  return (
    <div className="space-y-10 max-w-5xl mx-auto soft-enter">
      {/* Header */}
      <div>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
          Curation Passport
        </span>
        <h2 className="text-3xl sm:text-4xl font-editorial text-text tracking-tight font-bold mt-1">
          Strumm Passport
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
              <span className="text-primary font-mono">№ ST-{profileUser.createdAt.substring(2, 4)}{profileUser.id.substring(0, 4).toUpperCase()}</span>
            </div>

            {/* Photo Avatar */}
            <div className="w-28 h-28 rounded-full bg-surface-elevated overflow-hidden border-2 border-border/80 mx-auto relative shadow-inner">
              {profileUser.avatar ? (
                <img src={profileUser.avatar} alt={profileUser.displayName} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <UserIcon className="w-10 h-10 text-muted" />
                </div>
              )}
            </div>

            {/* Basic Info */}
            <div className="space-y-1">
              <h3 className="font-editorial text-2xl text-text font-bold leading-tight">
                {profileUser.displayName}
              </h3>
              <p className="text-xs text-muted">@{profileUser.username}</p>
              <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted/65 mt-2 font-semibold">
                <Calendar className="w-3.5 h-3.5" />
                <span>Issued {new Date(profileUser.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Passport Stamps/Badges */}
            <div className="space-y-3 border-t border-border/20 pt-5">
              <h4 className="text-[10px] tracking-wider uppercase text-muted font-bold text-left select-none">
                Passport Stamp Archives
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {badges.map((badge, idx) => {
                  const Icon = badge.icon;
                  return (
                    <div
                      key={idx}
                      className="p-2.5 rounded-lg bg-surface-elevated border border-border/40 flex items-center gap-2 text-left"
                    >
                      <div className="p-1.5 bg-primary/10 border border-primary/20 text-primary rounded">
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold text-text truncate leading-tight">
                          {badge.name}
                        </div>
                        <div className="text-[8px] text-muted truncate mt-0.5 leading-none">
                          {badge.desc}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

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
          </div>
        </div>

        {/* Right: Metrics and Stats */}
        <div className="lg:col-span-7 space-y-8">
          {/* Main stats counters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center soft-enter hover:-translate-y-0.5 transition-transform">
              <Clock className="w-5 h-5 text-primary mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {totalMinutes}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Total Min
              </div>
            </div>
            
            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center soft-enter hover:-translate-y-0.5 transition-transform">
              <Calendar className="w-5 h-5 text-accent mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {monthlyMinutes}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Month Min
              </div>
            </div>

            <div className="bg-surface/30 border border-border/40 rounded-xl p-4 text-center soft-enter hover:-translate-y-0.5 transition-transform">
              <Heart className="w-5 h-5 text-rose-500 mx-auto mb-1.5" />
              <div className="text-2xl font-editorial font-bold text-text">
                {likedCount}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted font-bold mt-1">
                Likes
              </div>
            </div>
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
                      <span className="font-semibold text-text">{artist.name}</span>
                    </div>
                    <span className="text-muted font-semibold">{artist.playCount} plays</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Playlists grid */}
          <div className="space-y-4">
            <h3 className="font-editorial text-xl text-text border-b border-border/20 pb-2">
              Curator Folder Archives
            </h3>
            {playlists.length === 0 ? (
              <p className="text-xs text-muted italic">No playlists created yet.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {playlists.map((playlist) => (
                  <a
                    key={playlist.id}
                    href={`/playlist/${playlist.id}`}
                    className="p-3.5 bg-surface/40 hover:bg-surface border border-border/40 hover:border-border/80 rounded-xl flex items-center justify-between transition group cursor-pointer"
                  >
                    <div>
                      <div className="font-editorial text-base text-text font-bold leading-tight group-hover:text-primary transition">
                        {playlist.name}
                      </div>
                      <div className="text-xs text-muted mt-1">{playlist.songs.length} records</div>
                    </div>
                    <div className="p-2 bg-surface-elevated rounded-lg border border-border/40 text-muted group-hover:text-primary transition">
                      <Library className="w-4 h-4" />
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {isDeleteModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeleteModalOpen(false)}
              className="absolute inset-0 bg-background/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: "spring", duration: 0.35 }}
              className="relative w-full max-w-md bg-surface border border-border/80 rounded-xl p-6 shadow-2xl space-y-6 z-10"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-primary/15 border border-primary/25 text-primary rounded-lg">
                    <Trash2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-editorial text-xl text-text font-bold leading-tight">Delete Account</h3>
                    <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mt-0.5">
                      This action is irreversible
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="p-1 hover:bg-surface-elevated text-muted hover:text-text rounded transition cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>

              <div className="text-xs text-muted leading-relaxed space-y-2.5">
                <p>Your profile, playlists, liked songs, history, stats, and player state will be permanently erased.</p>
                <div className="bg-primary/5 border border-primary/10 rounded-lg p-3 text-primary">
                  Type <span className="font-bold">DELETE</span> below to confirm.
                </div>
              </div>

              <input
                type="text"
                placeholder="DELETE"
                value={deleteConfirmationInput}
                onChange={(e) => setDeleteConfirmationInput(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text focus:outline-none focus:border-primary/50 transition font-semibold tracking-wider text-center"
              />

              <div className="flex gap-3">
                <button
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="flex-1 py-2.5 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-lg transition cursor-pointer select-none"
                >
                  Keep Account
                </button>
                <button
                  onClick={triggerDeleteAccount}
                  disabled={deleteConfirmationInput.trim().toUpperCase() !== "DELETE" || deleting}
                  className="flex-1 py-2.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg transition cursor-pointer select-none disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Confirm Delete
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
