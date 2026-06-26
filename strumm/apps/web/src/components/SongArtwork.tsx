"use client";

import { useEffect, useMemo, useState } from "react";
import { Music } from "lucide-react";
import { Song } from "@strumm/types";
import { getArtworkCandidates } from "web/lib/media";

interface SongArtworkProps {
  song?: Pick<Song, "videoId" | "thumbnail" | "title"> | null;
  alt?: string;
  className?: string;
  iconClassName?: string;
  priority?: boolean;
  /** 
   * Responsive sizes hint for the browser.
   * Example: "(max-width: 768px) 256px, 320px"
   */
  sizes?: string;
}

export default function SongArtwork({
  song,
  alt,
  className = "",
  iconClassName = "w-5 h-5",
  priority = false,
  sizes,
}: SongArtworkProps) {
  // For priority (hero) images, generate optimized proxy URLs
  const candidates = useMemo(
    () => getArtworkCandidates(song, priority),
    [song?.videoId, song?.thumbnail, priority],
  );
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setIndex(0);
    setLoaded(false);
    setErrored(false);
  }, [song?.videoId, song?.thumbnail]);

  const src = candidates[index];

  const handleLoad = () => {
    setLoaded(true);
    setErrored(false);
  };

  const handleError = () => {
    setLoaded(false);
    const nextIndex = index + 1;
    if (nextIndex < candidates.length) {
      setIndex(nextIndex);
    } else {
      setErrored(true);
    }
  };

  return (
    <div className={`relative overflow-hidden bg-surface-elevated ${className}`}>
      {/* Polished shimmer skeleton while loading */}
      {!loaded && !errored && <div className="image-skeleton" />}

      {/* Fallback icon when all candidates fail */}
      {errored || !src ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted z-20">
          <Music className={iconClassName} />
        </div>
      ) : (
        <img
          src={src}
          alt={alt || song?.title || "Artwork"}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          sizes={sizes}
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover ${
            loaded ? "image-reveal" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}
