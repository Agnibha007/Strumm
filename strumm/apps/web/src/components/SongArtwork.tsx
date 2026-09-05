"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Music } from "lucide-react";
import { Song } from "@strumm/types";
import { getArtworkCandidates } from "web/lib/media";
import { loadImage, preloadImage, type ImagePriority } from "web/lib/image-loader";

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
  // where the stack trace pointed at useMemo inside this component. The candidate
  // list is memoized at module scope in getArtworkCandidates, so the returned
  // array reference stays stable for a given (videoId, thumbnail, hero) key.
  const candidates = getArtworkCandidates(song, priority);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  // The candidate the pipeline has actually confirmed loadable. Unset until the
  // shared loader resolves a URL, so the DOM <img> below never initiates its own
  // (cancelable-on-tab-switch) lazy fetch — the eager synthetic fetch in the
  // pipeline is the only network request, and it keeps running in background tabs.
  const [src, setSrc] = useState<string | undefined>(undefined);

  // Safety net: if the pipeline can't resolve anything (every candidate hangs),
  // dismiss the skeleton so the user never sees a permanently stuck shimmer.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loaded || errored) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [loaded, errored, song?.videoId]);

  // Resolve the artwork through the shared throttle/dedup pipeline. Every fetch
  // is an eager synthetic <img> (the browser's native lazy loader pauses or
  // cancels image requests when you switch to another tab; the pipeline does
  // not, so "passive" background loading keeps working). Once a URL resolves it
  // is sitting in the HTTP cache, so the rendered <img> below paints instantly
  // without issuing a fresh network request.
  useEffect(() => {
    const basePriority: ImagePriority = priority ? 0 : 2;

    let cancelled = false;
    setLoaded(false);
    setErrored(false);
    setSrc(undefined);

    // Prime every candidate up-front (same URL deduped across the grid, bounded
    // concurrency) so a fallback is already cached if the first candidate fails.
    candidates.forEach((url, i) => {
      preloadImage(url, i === 0 ? basePriority : 3);
    });

    const resolveFrom = (start: number): void => {
      if (cancelled) return;
      if (candidates.length === 0) {
        setErrored(true);
        return;
      }
      for (let i = start; i < candidates.length; i++) {
        const url = candidates[i];
        if (!url) continue;
        const priorityFor = i === 0 ? basePriority : 3;
        loadImage(url, priorityFor).then((ok) => {
          if (cancelled) return;
          if (ok) {
            setSrc(url);
            setLoaded(true);
          } else if (i >= candidates.length - 1) {
            setErrored(true);
          } else {
            resolveFrom(i + 1);
          }
        });
        return;
      }
      setErrored(true);
    };

    resolveFrom(0);
    return () => {
      cancelled = true;
    };
  }, [candidates, priority]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    setErrored(false);
  }, []);

  // The pipeline already decided the URL is good; if the DOM element still
  // can't render it (cache eviction / partition mismatch), bail to the icon
  // rather than fighting the loader over which candidate is next.
  const handleError = useCallback(() => {
    setLoaded(false);
    setErrored(true);
  }, []);

  const imgRef = useRef<HTMLImageElement | null>(null);

  // Cached-image guard: when a candidate URL is already in the browser cache
  // the load can complete (and onload fire) before React attaches onLoad, so
  // `loaded` never flips and the art stays invisible at opacity-0. Detecting
  // img.complete && naturalWidth handles that case immediately.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
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

      {/* Fallback icon when every candidate fails */}
      {errored ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted z-20">
          <Music className={iconClassName} />
        </div>
      ) : loaded && src ? (
        <img
          ref={handleImgRef}
          src={src}
          alt={alt || song?.title || "Artwork"}
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          sizes={sizes}
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover image-reveal`}
          style={{
            imageRendering: "auto",
          }}
        />
      ) : null}
    </div>
  );
}