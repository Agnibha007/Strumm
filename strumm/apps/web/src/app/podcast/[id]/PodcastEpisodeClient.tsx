"use client";

import { useEffect, useState, use } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";
import { apiUrl } from "web/lib/api";
import { Song, PodcastEpisode, PodcastShow } from "@strumm/types";

interface PodcastEpisodeClientProps {
  params: Promise<{ id: string }>;
}

export default function PodcastEpisodeClient({ params }: PodcastEpisodeClientProps) {
  const { id } = use(params);
  const router = useRouter();
  const { playSong, setPodcastMode } = usePlayerStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPodcastEpisode = async () => {
      try {
        const response = await fetch(apiUrl(`/podcasts/episode/${id}`));
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(json?.error || "Podcast episode request failed.");
        }
        
        if (json?.success && json.data) {
          const episode = json.data.episode as PodcastEpisode;
          const show = json.data.show as PodcastShow;
          
          const songRepresentation: Song = {
            videoId: `podcast-${episode.id}`,
            title: episode.title,
            artist: show?.title || "Unknown Podcast",
            thumbnail: show?.image || "",
      duration: episode.duration,
      metadata: {
              album: show?.title || "Podcasts",
              audioUrl: episode.audioUrl,
              audioVariants: episode.audioVariants,
              videoAvailable: episode.videoAvailable,
              videoUrl: episode.videoUrl,
              mediaType: episode.mediaType,
              description: episode.description
            }
          };

          // If video is available, default to video mode
          setPodcastMode(episode.videoAvailable ? "video" : "audio");
          playSong(songRepresentation, [songRepresentation]);
          router.push("/");
        } else {
          setError(json?.error || "Podcast episode not found.");
        }
      } catch (err: any) {
        setError(err?.message || "Failed to resolve podcast episode.");
      } finally {
        setLoading(false);
      }
    };
    
    if (id) {
      loadPodcastEpisode();
    }
  }, [id, playSong, setPodcastMode, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Resolving Podcast Episode...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center p-6 space-y-4">
        <ShieldAlert className="w-12 h-12 text-primary mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Episode Unavailable</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">{error}</p>
        <button
          onClick={() => router.push("/podcasts")}
          className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border text-text text-xs font-semibold rounded-lg transition cursor-pointer"
        >
          Go to Podcasts Portal
        </button>
      </div>
    );
  }

  return null;
}
