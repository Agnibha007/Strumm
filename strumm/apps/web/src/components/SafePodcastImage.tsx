"use client";

import { useEffect, useState, useRef, type ImgHTMLAttributes } from "react";
import { apiUrl } from "web/lib/api";

type SafePodcastImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
};

export default function SafePodcastImage({ src, alt, className, ...props }: SafePodcastImageProps) {
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const attemptsRef = useRef(0);

  useEffect(() => {
    setCurrentSrc(src || null);
    setLoaded(false);
    setErrored(false);
    attemptsRef.current = 0;
  }, [src]);

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
          onLoad={handleLoad}
          onError={handleError}
          className={`absolute inset-0 w-full h-full object-fill ${
            loaded ? "image-reveal" : "opacity-0"
          }`}
          {...props}
        />
      )}
    </div>
  );
}
