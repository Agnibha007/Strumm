"use client";

import { useEffect, useState, useRef, useCallback, type ImgHTMLAttributes } from "react";
import { apiUrl } from "web/lib/api";
import { loadImage, preloadImage } from "web/lib/image-loader";

/**
 * Maximum time (ms) to show the skeleton before forcing the fallback icon.
 * Prevents podcast artwork from being stuck in a perpetual loading state.
 */
const LOAD_TIMEOUT_MS = 12_000;

type SafePodcastImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
};

/** Upgrade http:// URLs to https:// to prevent Mixed Content warnings. */
function toSecureUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

export default function SafePodcastImage({ src, alt, className, ...props }: SafePodcastImageProps) {
  const [currentSrc, setCurrentSrc] = useState<string | null>(() => toSecureUrl(src));
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Safety net: dismiss the skeleton if the pipeline can't resolve any URL,
  // so artwork is never stuck shimmering forever.
  useEffect(() => {
    if (loaded || errored) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [loaded, errored, src]);

  // Resolve the artwork through the shared throttle/dedup pipeline. The fetch
  // is an eager synthetic <img> — the browser's native lazy loader cancels or
  // pauses image requests when the tab is hidden, but the pipeline does not,
  // so podcast art keeps "passively" downloading in background tabs. Once a
  // URL resolves it is in the HTTP cache, and the rendered <img> below paints
  // from cache without issuing a fresh, cancelable lazy request.
  useEffect(() => {
    const secured = toSecureUrl(src);
    const proxy = src
      ? apiUrl(`/image-proxy?url=${encodeURIComponent(src)}`)
      : null;

    let cancelled = false;
    setCurrentSrc(secured);
    setLoaded(false);
    setErrored(false);

    if (!secured) {
      setErrored(true);
      return;
    }

    // Prime the host URL and its proxy fallback up-front (shared, bounded
    // concurrency, deduped across the page).
    preloadImage(secured, 2);
    if (proxy) preloadImage(proxy, 3);

    const resolveFrom = (start: number): void => {
      if (cancelled) return;
      const candidates = [secured, proxy];
      for (let i = start; i < candidates.length; i++) {
        const url = candidates[i];
        if (!url) continue;
        loadImage(url, i === 0 ? 2 : 3).then((ok) => {
          if (cancelled) return;
          if (ok) {
            setCurrentSrc(url);
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
  }, [src]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    setErrored(false);
  }, []);

  // The pipeline already decided the URL is good; if the DOM element still
  // can't render it (cache eviction / partition mismatch), bail to the icon
  // rather than flipping between candidates.
  const handleError = useCallback(() => {
    setLoaded(false);
    setErrored(true);
  }, []);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const handleImgRef = useCallback((node: HTMLImageElement | null) => {
    imgRef.current = node;
  }, []);

  // Cached-image guard: a URL already in the browser cache can finish loading
  // (and fire onload) before React attaches onLoad, leaving opacity-0 forever.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      handleLoad();
    }
  }, [currentSrc, handleLoad]);

  return (
    <div className={`relative overflow-hidden bg-surface-elevated ${className || ""}`}>
      {/* Polished shimmer skeleton while loading */}
      {!loaded && !errored && <div className="image-skeleton" />}

      {/* Fallback icon when every candidate fails */}
      {errored || !currentSrc ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted z-20">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4 0h8" />
          </svg>
        </div>
      ) : loaded && currentSrc ? (
        <img
          ref={handleImgRef}
          src={currentSrc}
          alt={alt || "Podcast artwork"}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover image-reveal`}
          {...props}
          loading="eager"
        />
      ) : null}
    </div>
  );
}