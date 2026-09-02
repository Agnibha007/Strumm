"use client";

import { useEffect, useState } from "react";
import { Music } from "lucide-react";
import { Song } from "@strumm/types";
import { getArtworkCandidates } from "web/lib/media";
import { preloadImage, type ImagePriority } from "web/lib/image-loader";

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
  // NOTE: useMemo intentionally omitted. This is a trivial array/string computation;
  // removing the hook was a defensive measure against a production
  // "Rendered more hooks than during the previous render" error (Sentry ed36292a)
  // where the stack trace pointed at useMemo inside this component.
  const candidates = getArtworkCandidates(song, priority);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setIndex(0);
    setLoaded(false);
    setErrored(false);
  }, [song?.videoId, song?.thumbnail]);

  // Feed every candidate through the shared loader so a grid of artworks
  // (search/discovery/rooms) downloads through a single throttled, deduped,
  // priority-ordered pipeline instead of dozens of parallel requests. The
  // element's own onLoad/onError still drive the candidate fallback chain.
  useEffect(() => {
    const basePriority: ImagePriority = priority ? 0 : 2;
    candidates.forEach((src, i) => {
      preloadImage(src, i === 0 ? basePriority : 3);
    });
  }, [candidates, priority]);

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
          style={{
            imageRendering:'auto',
          }}
        />
      )}
    </div>
  );
}
