"use client";

import { useEffect, useState, use } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { useAuthStore } from "web/store/useAuthStore";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert, LogIn } from "lucide-react";
import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";
import { Song, PodcastEpisode, PodcastShow } from "@strumm/types";
import SafePodcastImage from "web/components/SafePodcastImage";
import { loginUrlFor } from "web/lib/routes";

interface PodcastEpisodeClientProps {
  params: Promise<{ id: string }>;
}

interface ResolvedEpisode {
  episode: PodcastEpisode;
  show: PodcastShow | null;
}

/**
 * Public podcast episode route. Guests can read the episode page, but the
 * player itself only exists for signed-in users, so a guest is offered sign-in
 * with this episode as the return destination rather than being bounced home to
 * an app with no player.
 */
export default function PodcastEpisodeClient({ params }: PodcastEpisodeClientProps) {
  const { id } = use(params);
  const router = useRouter();
  const { playSong, setPodcastMode } = usePlayerStore();
  const { user } = useAuthStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedEpisode | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadPodcastEpisode = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await authFetch(apiUrl(`/podcasts/episode/${id}`));
        const json = await response.json().catch(() => null);
        if (cancelled) return;

        if (!response.ok) {
          throw new Error(json?.error || "Podcast episode request failed.");
        }

        if (json?.success && json.data?.episode) {
          setResolved({
            episode: json.data.episode as PodcastEpisode,
            show: (json.data.show as PodcastShow) ?? null,
          });
        } else {
          setError(json?.error || "Podcast episode not found.");
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Failed to resolve podcast episode.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (id) void loadPodcastEpisode();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Play only where a player exists (i.e. the visitor is signed in).
  useEffect(() => {
    if (!resolved || !user) return;

    const { episode, show } = resolved;
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
        description: episode.description,
      },
    };

    // If video is available, default to video mode
    setPodcastMode(episode.videoAvailable ? "video" : "audio");
    playSong(songRepresentation, [songRepresentation]);
    router.push("/");
  }, [resolved, user, playSong, setPodcastMode, router]);

  const handleSignIn = () => {
    router.push(loginUrlFor(`/podcast/${encodeURIComponent(id)}`));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Resolving Podcast Episode...</p>
      </div>
    );
  }

  if (error || !resolved) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center p-6 space-y-4">
        <ShieldAlert className="w-12 h-12 text-primary mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Episode Unavailable</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">
          {error || "This episode could not be loaded."}
        </p>
        <button
          onClick={() => router.push("/podcasts")}
          className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border text-text text-xs font-semibold rounded-lg transition cursor-pointer"
        >
          Go to Podcasts Portal
        </button>
      </div>
    );
  }

  if (user) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Opening Episode...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm bg-surface border border-border/80 rounded-2xl p-8 shadow-2xl text-center space-y-6">
        {resolved.show?.image && (
          <div className="w-40 h-40 rounded-xl overflow-hidden border border-border/60 mx-auto shadow-lg">
            <SafePodcastImage
              src={resolved.show.image}
              alt={resolved.show.title || "Podcast artwork"}
              className="w-full h-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <p className="text-[9px] tracking-widest uppercase font-semibold text-primary">
            Shared Episode
          </p>
          <h1 className="text-xl font-editorial text-text font-bold leading-tight">
            {resolved.episode.title}
          </h1>
          <p className="text-xs text-muted">
            From <strong className="text-text">{resolved.show?.title || "Podcast"}</strong>
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
          Playback needs a Strumm account. You&apos;ll come straight back to this episode.
        </p>
      </div>
    </div>
  );
}
