"use client";

import { useEffect, useState, useRef, type ImgHTMLAttributes } from "react";
import { apiUrl } from "web/lib/api";
import { preloadImage } from "web/lib/image-loader";

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
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCurrentSrc(toSecureUrl(src));
    setLoaded(false);
    setErrored(false);
    attemptsRef.current = 0;

    // Prime the host URL and its proxy fallback through the shared throttled
    // loader, so a page of podcast art downloads at bounded concurrency with
    // dedup instead of a burst of parallel requests.
    const secured = toSecureUrl(src);
    if (secured) {
      preloadImage(secured, 2);
      preloadImage(apiUrl(`/image-proxy?url=${encodeURIComponent(secured)}`), 3);
    }

    // Safety net: dismiss skeleton if nothing loads within the timeout.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [src]);

  // Clear the timeout as soon as the image is confirmed loaded.
  useEffect(() => {
    if (loaded && timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, [loaded]);

  const handleLoad = () => {
    setLoaded(true);
    setErrored(false);
  };

  const handleError = () => {
    setLoaded(false);
    attemptsRef.current += 1;

    if (attemptsRef.current === 1 && src) {
      // First fallback: try via image-proxy
      setCurrentSrc(apiUrl(`/image-proxy?url=${encodeURIComponent(src)}`));
    } else {
      // All attempts failed
      setErrored(true);
    }
  };

  return (
    <div className={`relative overflow-hidden bg-surface-elevated ${className || ""}`}>
      {/* Polished shimmer skeleton while loading */}
      {!loaded && !errored && <div className="image-skeleton" />}

      {errored || !currentSrc ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted z-20">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4 0h8" />
          </svg>
        </div>
      ) : (
        <img
          src={currentSrc}
          alt={alt || "Podcast artwork"}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-cover ${
            loaded ? "image-reveal" : "opacity-0"
          }`}
          {...props}
        />
      )}
    </div>
  );
}
