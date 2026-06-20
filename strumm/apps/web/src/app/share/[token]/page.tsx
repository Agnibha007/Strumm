"use client";

import { useEffect, useState, use } from "react";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Play, FolderHeart, Music, Eye, Loader2, ArrowRight, ShieldAlert } from "lucide-react";
import { Song, Playlist } from "@strumm/types";
import { useRouter } from "next/navigation";
import { apiUrl } from "web/lib/api";
import BrandLogo from "web/components/BrandLogo";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

export default function SharePage({ params }: SharePageProps) {
  const { token } = use(params);
  const router = useRouter();
  const { playSong } = usePlayerStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareData, setShareData] = useState<{
    contentType: "song" | "playlist";
    content: any;
    views: number;
  } | null>(null);

  useEffect(() => {
    const fetchSharedContent = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(apiUrl(`/share/${encodeURIComponent(token)}`));
        const json = await response.json();
        if (json.success && json.data) {
          setShareData(json.data);
        } else {
          setError(json.error || "Shared content not found or link expired.");
        }
      } catch (e) {
        setError("Unable to connect to backend server.");
      } finally {
        setLoading(false);
      }
    };

    if (token) {
      fetchSharedContent();
    }
  }, [token]);

  const handlePlayContent = () => {
    if (!shareData) return;
    if (shareData.contentType === "song") {
      const song = shareData.content as Song;
      playSong(song, [song]);
    } else if (shareData.contentType === "playlist") {
      const playlist = shareData.content as Playlist;
      if (playlist.songs.length > 0) {
        playSong(playlist.songs[0], playlist.songs);
      }
    }
    // Take user to home to see play experience
    router.push("/");
  };

  useEffect(() => {
    if (shareData && !error) {
      handlePlayContent();
    }
  }, [shareData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-muted gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-xs uppercase tracking-widest">Opening Shared Envelope...</p>
      </div>
    );
  }

  if (error || !shareData) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center p-6 space-y-4">
        <ShieldAlert className="w-12 h-12 text-primary mx-auto" />
        <h3 className="font-editorial text-2xl text-text font-bold">Failed to Load Content</h3>
        <p className="text-sm text-muted max-w-sm mx-auto">{error || "This shared link is no longer valid."}</p>
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 bg-surface-elevated hover:bg-surface border border-border text-text text-xs font-semibold rounded-lg transition cursor-pointer"
        >
          Go to Strumm
        </button>
      </div>
    );
  }

  const isSong = shareData.contentType === "song";
  const item = shareData.content;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Blurred thumbnail backdrop */}
      <div 
        className="absolute inset-0 bg-cover bg-center filter blur-3xl opacity-20 transition-all duration-1000 scale-110"
        style={{ backgroundImage: `url(${isSong ? item.thumbnail : (item.songs?.[0]?.thumbnail || "")})` }}
      />
      <div className="absolute inset-0 bg-black/80" />

      {/* Main card */}
      <div className="relative z-10 w-full max-w-lg bg-surface border border-border/80 rounded-xl p-8 shadow-2xl space-y-6 text-center">
        {/* Branding header */}
        <div className="flex flex-col items-center text-center space-y-2">
          <BrandLogo variant="mark" size="md" priority />
          <span className="text-[9px] tracking-widest uppercase font-semibold text-primary block">
            Shared Sound Capsule
          </span>
        </div>

        {/* Thumbnail art */}
        <div className="w-40 h-40 rounded-xl overflow-hidden shadow-2xl border border-border/80 mx-auto relative group">
          {isSong ? (
            <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />
          ) : item.songs?.length > 0 ? (
            <div className="grid grid-cols-2 grid-rows-2 w-full h-full">
              {item.songs.slice(0, 4).map((s: Song, idx: number) => (
                <img key={idx} src={s.thumbnail} alt="" className="w-full h-full object-cover" />
              ))}
            </div>
          ) : (
            <div className="w-full h-full bg-surface-elevated flex items-center justify-center">
              <FolderHeart className="w-12 h-12 text-accent/60" />
            </div>
          )}
        </div>

        {/* Details text */}
        <div className="space-y-2">
          {isSong ? (
            <>
              <h2 className="text-xl font-editorial text-text font-bold leading-tight truncate px-4">
                {item.title}
              </h2>
              <p className="text-xs text-muted">Song by <strong className="text-text">{item.artist}</strong></p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-editorial text-text font-bold leading-tight truncate px-4">
                {item.name}
              </h2>
              <p className="text-xs text-muted">
                Playlist Curation • <strong className="text-text">{item.songs?.length || 0} tracks</strong>
              </p>
              <p className="text-xs text-muted/65 italic max-w-xs mx-auto leading-relaxed mt-1">
                {item.description || "No description provided."}
              </p>
            </>
          )}
        </div>

        {/* Statistics views */}
        <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted font-semibold uppercase tracking-wider bg-surface-elevated/40 border border-border/40 py-1.5 px-3 rounded-full w-max mx-auto select-none">
          <Eye className="w-3.5 h-3.5" />
          <span>{shareData.views} plays / views</span>
        </div>

        {/* Play button action */}
        <button
          onClick={handlePlayContent}
          className="w-full py-3 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition select-none shadow-lg"
        >
          <Play className="w-4 h-4 fill-current" />
          Play in Strumm App
        </button>

        {/* Action button redirection to home */}
        <div className="border-t border-border/40 pt-4 text-center">
          <button
            onClick={() => router.push("/")}
            className="text-xs text-muted hover:text-text font-semibold flex items-center gap-1.5 mx-auto transition cursor-pointer select-none"
          >
            Enter Strumm Platform
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
