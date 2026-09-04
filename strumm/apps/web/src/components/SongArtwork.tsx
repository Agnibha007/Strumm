"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Music } from "lucide-react";
import { Song } from "@strumm/types";
import { getArtworkCandidates } from "web/lib/media";
import { preloadImage, type ImagePriority } from "web/lib/image-loader";

/**
 * Maximum time (ms) to show the skeleton before forcing the fallback icon.
 * Prevents images from being stuck in a perpetual loading state when every
 * candidate URL hangs (slow CDN, zombie connection, etc.).
 */
const LOAD_TIMEOUT_MS = 12_000;

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

  // Safety net: if every candidate hangs, dismiss the skeleton so the
  // user never sees a permanently stuck shimmer.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loaded || errored) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [loaded, errored, song?.videoId]);

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
  const imgRef = useRef<HTMLImageElement | null>(null);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    setErrored(false);
  }, []);

  const handleError = useCallback(() => {
    setLoaded(false);
    if (index >= candidates.length - 1) {
      setErrored(true);
    } else {
      setIndex(index + 1);
    }
  }, [index, candidates.length]);

  // Cached-image guard: when a candidate URL is already in the browser cache
  // the load can complete (and onload fire) before React attaches onLoad, so
  // `loaded` never flips and the art stays invisible at opacity-0. Detecting
  // img.complete && naturalWidth handles that case (and duplicate concurrent
  // mounts of the same cached URL) immediately.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      handleLoad();
    }
  }, [src, handleLoad]);

  const handleImgRef = useCallback((node: HTMLImageElement | null) => {
    imgRef.current = node;
  }, []);

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
          ref={handleImgRef}
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
