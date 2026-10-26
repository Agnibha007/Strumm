"use client";

import { useEffect, useState, use } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useAuthStore } from "web/store/useAuthStore";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert, LogIn, Play } from "lucide-react";
import type { Song } from "@strumm/types";
import SongArtwork from "web/components/SongArtwork";
import { ARTWORK_QUALITY_HIGH } from "web/lib/media";
import { loginUrlFor } from "web/lib/routes";

interface SongPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Public song route. It is linked from share sheets, so a signed-out visitor can
 * land here — but there is no player for a guest (see PersistentPlayerWrapper,
 * which needs a session). Before this, the page called playSong() and pushed
 * home, so the guest arrived at a page with no player and the track was silently
 * discarded. Now a guest gets the resolved track and a sign-in CTA that returns
 * them here, where the authenticated auto-play path takes over.
 */
export default function SongDetailClient({ params }: SongPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { playSong } = usePlayerStore();
  const { user } = useAuthStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [song, setSong] = useState<Song | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadSong = async () => {
      setLoading(true);
      setError(null);
      try {
        // Search for the video by ID via the search API to get full metadata
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(id)}&type=video`,
        );
        const json = await res.json().catch(() => null);
        if (cancelled) return;

        const found: Song | null =
          json?.success && Array.isArray(json.data?.songs) && json.data.songs[0]
            ? json.data.songs[0]
            : null;

        // Fallback: build a minimal Song from the video ID alone. The engine's
        // YouTube player will fill in the real details.
        setSong(
          found ?? {
            videoId: id,
            title: id,
            artist: "YouTube",
            thumbnail: "",
            duration: 0,
          },
        );
      } catch {
        if (!cancelled) setError("Failed to resolve song.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (id) void loadSong();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Only a signed-in visitor has a mounted player to play into.
  useEffect(() => {
    if (!song || !user) return;
    playSong(song, [song]);
    router.push("/");
  }, [song, user, playSong, router]);

  const handleSignIn = () => {
    // Preserve the destination so the return trip lands back here, where the
    // effect above plays the track and hands over to the app.
    router.push(loginUrlFor(`/song/${encodeURIComponent(id)}`));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Resolving Track...</p>
      </div>
    );
  }

  if (error || !song) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center p-6 space-y-4">
        <ShieldAlert className="w-12 h-12 text-primary mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Track Unavailable</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">
          {error || "This track could not be loaded."}
        </p>
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border text-text text-xs font-semibold rounded-lg transition cursor-pointer"
        >
          Go to Home
        </button>
      </div>
    );
  }

  // Signed-in visitors are already being redirected by the effect above.
  if (user) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Opening Player...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-border/80 rounded-2xl p-8 shadow-2xl text-center space-y-6">
        <div className="w-40 h-40 rounded-xl overflow-hidden border border-border/60 mx-auto shadow-lg">
          <SongArtwork song={song} className="w-full h-full" quality={ARTWORK_QUALITY_HIGH} />
        </div>
        <div className="space-y-1.5">
          <p className="text-[9px] tracking-widest uppercase font-semibold text-primary">
            Shared Track
          </p>
          <h1 className="text-xl font-editorial text-text font-bold leading-tight">
            {song.title}
          </h1>
          <p className="text-xs text-muted">
            Song by <strong className="text-text">{song.artist}</strong>
          </p>
        </div>
        <button
          onClick={handleSignIn}
          className="w-full py-3 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition shadow-lg"
        >
          <LogIn className="w-4 h-4" />
          Sign in to play
        </button>
        <p className="text-[10px] text-muted/70 leading-relaxed">
          Playback needs a Strumm account. You&apos;ll come straight back to this track.
        </p>
        <button
          onClick={() => router.push("/")}
          className="text-[11px] text-muted hover:text-text font-semibold transition cursor-pointer inline-flex items-center gap-1.5"
        >
          <Play className="w-3 h-3" />
          Explore Strumm instead
        </button>
      </div>
    </div>
  );
}
