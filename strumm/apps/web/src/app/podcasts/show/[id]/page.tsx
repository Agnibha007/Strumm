"use client";

import { useEffect, useState, use } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Radio, Plus, Check, Play, Clock, ArrowLeft, Loader2 } from "lucide-react";
import { PodcastShow, PodcastEpisode, Song } from "@strumm/types";
import { useRouter } from "next/navigation";
import { apiUrl, stripHtml } from "web/lib/api";
import SafePodcastImage from "web/components/SafePodcastImage";

interface PodcastShowPageProps {
  params: Promise<{ id: string }>;
}

export default function PodcastShowPage({ params }: PodcastShowPageProps) {
  const { id } = use(params);
  const { token } = useAuthStore();
  const { playSong, setPodcastMode } = usePlayerStore();
  const router = useRouter();



  const [show, setShow] = useState<PodcastShow | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const EPISODES_PER_PAGE = 5;

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    const episodesSection = document.getElementById("episodes-section");
    if (episodesSection) {
      episodesSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const loadShowDetails = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/podcasts/shows/${encodeURIComponent(id)}`));
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error || "Failed to load show details.");
      }
      if (json.success && json.data) {
        setShow(json.data.show);
        setEpisodes(json.data.episodes || []);
      } else {
        setError(json?.error || "Failed to load show details.");
      }
    } catch (e: any) {
      setError(e?.message || "Unable to connect to backend server.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) {
      loadShowDetails();
      setCurrentPage(1);
    }
  }, [id]);

  const handleFollowShow = async () => {
    setFollowError(null);
    try {
      const response = await fetch(apiUrl(`/podcasts/shows/${encodeURIComponent(id)}/follow`), {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error || "Failed to update follow status.");
      }
      if (json.success) {
        setFollowing(json.data.following);
      } else {
        setFollowError(json?.error || "Failed to update follow status.");
      }
    } catch (e: any) {
      setFollowError(e?.message || "Failed to toggle follow status.");
    }
  };

  const handlePlayEpisode = (episode: PodcastEpisode, forceVideo: boolean = false) => {
    // Map dynamic PodcastEpisode type to Song shape for unified player handling
    const songRepresentation: Song = {
      videoId: `podcast-${episode.id}`,
      title: episode.title,
      artist: show?.title || "Unknown Podcast",
      thumbnail: show?.image || "",
      duration: episode.duration,
      hasVideo: Boolean(episode.videoAvailable),
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
    setPodcastMode(forceVideo && episode.videoAvailable ? "video" : "audio");
    playSong(songRepresentation, []);
  };

  const formatEpisodeDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    if (mins > 60) {
      const hrs = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      return `${hrs} hr ${remainingMins} min`;
    }
    return `${mins} min`;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Opening Podcast Log...</p>
      </div>
    );
  }

  if (error || !show) {
    return (
      <div className="text-center py-20 space-y-4">
        <Radio className="w-12 h-12 text-muted mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Unable to resolve podcast</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">{error || "Podcast archive does not exist."}</p>
        <button
          onClick={() => router.push("/podcasts")}
          className="px-4 py-2 border border-border hover:bg-surface-elevated text-text text-xs font-semibold rounded-lg transition flex items-center gap-2 mx-auto cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Podcast Portal
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-10 max-w-5xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => router.push("/podcasts")}
        className="flex items-center gap-2 text-muted hover:text-text transition text-xs font-semibold select-none cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4 text-white" />
        Back to Portal
      </button>

      {/* Podcast Hero Section */}
      <div className="flex flex-col md:flex-row items-center md:items-end gap-8 pb-4">
        {/* Cover image */}
        <div className="w-48 h-48 md:w-56 md:h-56 rounded-xl overflow-hidden border border-border/80 relative shadow-2xl flex-shrink-0">
          <SafePodcastImage
            src={show.image}
            alt={show.title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        </div>

        {/* Text details */}
        <div className="text-center md:text-left flex-grow space-y-4">
          <div className="space-y-2">
            <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
              Podcast Series
            </span>
            <h1 className="text-4xl md:text-5xl font-editorial font-bold text-text tracking-tight leading-tight break-words w-full">
              {show.title}
            </h1>
            <p className="text-sm text-muted max-w-2xl leading-relaxed break-words whitespace-pre-wrap line-clamp-4 md:line-clamp-none">
              {show.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-4 gap-y-1.5 text-xs text-muted">
            <span className="font-semibold text-text">By {show.author}</span>
            <span>•</span>
            <span>{episodes.length} episodes</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="border-y border-border/20 py-4 flex items-center justify-between gap-4">
        <button
          onClick={handleFollowShow}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-semibold shadow-md cursor-pointer transition select-none ${
            following
              ? "bg-surface-elevated hover:bg-surface border border-border text-text"
              : "bg-primary hover:bg-primary-hover text-white"
          }`}
        >
          {following ? (
            <>
              <Check className="w-4 h-4" />
              Following Series
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Follow Series
            </>
          )}
        </button>
      </div>

      {followError && (
        <div className="text-xs text-primary bg-primary/5 border border-primary/20 p-3 rounded-lg leading-relaxed">
          {followError}
        </div>
      )}

      {/* Episode list */}
      <div className="space-y-4">
        <h3 id="episodes-section" className="font-editorial text-2xl text-text border-b border-border/20 pb-2">
          Episodes
        </h3>
        
        {episodes.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border/60 rounded-xl bg-surface/20">
            <Radio className="w-8 h-8 text-muted mx-auto mb-2" />
            <p className="text-xs text-muted">No episodes found inside this podcast feed.</p>
          </div>
        ) : (() => {
          const totalPages = Math.ceil(episodes.length / EPISODES_PER_PAGE);
          const paginatedEpisodes = episodes.slice((currentPage - 1) * EPISODES_PER_PAGE, currentPage * EPISODES_PER_PAGE);
          return (
            <div className="space-y-6">
              <div className="space-y-4">
                {paginatedEpisodes.map((episode) => (
                  <div
                    key={episode.id}
                    className="bg-surface/30 border border-border/40 hover:border-border/80 rounded-xl p-5 text-left flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 transition group"
                  >
                    <div className="space-y-2 flex-grow min-w-0">
                      <h4 className="font-editorial text-lg text-text font-bold truncate break-words w-full group-hover:text-primary transition leading-snug">
                        {episode.title}
                      </h4>
                      <p className="text-xs text-muted max-w-3xl line-clamp-2 break-words w-full leading-relaxed">
                        {stripHtml(episode.description)}
                      </p>
                      <div className="flex items-center gap-3 text-[10px] text-muted font-bold uppercase tracking-wider">
                        <Clock className="w-3.5 h-3.5 text-primary" />
                        <span>{formatEpisodeDuration(episode.duration)}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handlePlayEpisode(episode, false)}
                        className="px-4 py-2 bg-surface-elevated hover:bg-primary text-text hover:text-white border border-border/80 hover:border-primary/20 text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer transition select-none"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Stream Episode
                      </button>

                      {episode.videoAvailable && (
                        <button
                          onClick={() => handlePlayEpisode(episode, true)}
                          className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center gap-2 cursor-pointer transition select-none"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          Watch Video
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-6 border-t border-border/20 select-none">
                  <button
                    onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border/80 text-xs font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-text"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-muted font-medium">
                    Page <span className="text-text font-bold">{currentPage}</span> of <span className="text-text font-bold">{totalPages}</span>
                  </span>
                  <button
                    onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border/80 text-xs font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer text-text"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
