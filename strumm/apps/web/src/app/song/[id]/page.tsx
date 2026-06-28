"use client";

import { useEffect, useState, use } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";
import { apiUrl } from "web/lib/api";
import { getVideoDetails } from "web/lib/invidious";
import BrandLogo from "web/components/BrandLogo";
import { Song } from "@strumm/types";

interface SongPageProps {
  params: Promise<{ id: string }>;
}

export default function SongPage({ params }: SongPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { playSong } = usePlayerStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadSong = async () => {
      try {
        const song = await getVideoDetails(id);
        if (song) {
          playSong(song, [song]);
          router.push("/");
        } else {
          setError("Song not found.");
        }
      } catch (err) {
        setError("Failed to resolve song.");
      } finally {
        setLoading(false);
      }
    };
    
    if (id) {
      loadSong();
    }
  }, [id, playSong, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Resolving Track...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center p-6 space-y-4">
        <ShieldAlert className="w-12 h-12 text-primary mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Track Unavailable</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">{error}</p>
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border text-text text-xs font-semibold rounded-lg transition cursor-pointer"
        >
          Go to Home
        </button>
      </div>
    );
  }

  return null;
}
