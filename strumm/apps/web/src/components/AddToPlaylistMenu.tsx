"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { PlusCircle, Loader2, X } from "lucide-react";
import { useAuthStore } from "web/store/useAuthStore";
import { useNotificationStore } from "web/store/useNotificationStore";
import { apiUrl } from "web/lib/api";
import { Playlist, Song } from "@strumm/types";
import { motion, AnimatePresence } from "framer-motion";

interface AddToPlaylistMenuProps {
  song: Song | null;
  className?: string;
  iconClassName?: string;
}

export default function AddToPlaylistMenu({ song, className = "", iconClassName = "w-4 h-4" }: AddToPlaylistMenuProps) {
  const { token, user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const isMountedRef = useRef(true);

  const { show } = useNotificationStore();

  useEffect(() => {
    setMounted(true);
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchPlaylists = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/playlists"), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setPlaylists(json.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    if (!song) return;
    setOpen(true);
    fetchPlaylists();
  };

  const handleAddToPlaylist = async (playlistId: string) => {
    if (!song) return;
    try {
      const res = await fetch(apiUrl(`/playlists/${playlistId}/songs`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ song })
      });
      const json = await res.json();
      if (json.success) {
        show(`Added "${song.title}" to playlist!`, "success");
      } else {
        show(json.error || "Failed to add to playlist", json.error?.includes("already") ? "warning" : "error");
      }
    } catch (e) {
      show("Error adding to playlist", "error");
    } finally {
      setOpen(false);
    }
  };

  if (!user || !song) return null;

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); handleOpen(); }}
        className={`p-2 rounded hover:bg-surface-elevated cursor-pointer transition text-muted hover:text-text ${className}`}
        title="Add to Playlist"
      >
        <PlusCircle className={iconClassName} />
      </button>

      {mounted && isMountedRef.current && typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {open && (
            <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={(e) => { e.stopPropagation(); setOpen(false); }}
              className="absolute inset-0 bg-background/80 backdrop-blur-sm cursor-auto"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-sm bg-surface border border-border/60 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh] cursor-auto"
            >
              <div className="flex items-center justify-between p-4 border-b border-border/40">
                <h3 className="font-editorial font-bold text-lg text-text">Add to Playlist</h3>
                <button onClick={() => setOpen(false)} className="text-muted hover:text-text cursor-pointer transition">
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-2">
                {loading ? (
                  <div className="flex justify-center p-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : playlists.length > 0 ? (
                  <div className="space-y-1">
                    {playlists.map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleAddToPlaylist(p.id)}
                        className="w-full text-left p-3 hover:bg-surface-elevated rounded-lg transition group cursor-pointer flex items-center justify-between"
                      >
                        <span className="font-semibold text-sm text-text/90 group-hover:text-primary">{p.name}</span>
                        <span className="text-xs text-muted">{p.songs.length} songs</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-center p-6 text-sm text-muted">
                    No playlists found. Create one in your Library.
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
      document.body
    )}
  </>
);
}
