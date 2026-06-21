"use client";

import { useEffect, useMemo, useState } from "react";
import { Music } from "lucide-react";
import { Song } from "@strumm/types";
import { getArtworkCandidates } from "web/lib/media";
import { apiUrl } from "web/lib/api";
import Image from "next/image";

interface SongArtworkProps {
  song?: Pick<Song, "videoId" | "thumbnail" | "title"> | null;
  alt?: string;
  className?: string;
  iconClassName?: string;
}

export default function SongArtwork({
  song,
  alt,
  className = "",
  iconClassName = "w-5 h-5",
}: SongArtworkProps) {
  const candidates = useMemo(() => {
    const directCandidates = getArtworkCandidates(song);
    const proxiedCandidates = directCandidates
      .filter((candidate) => candidate.startsWith("http"))
      .map((candidate) => apiUrl(`/image-proxy?url=${encodeURIComponent(candidate)}`));

    return [...directCandidates, ...proxiedCandidates];
  }, [song?.videoId, song?.thumbnail]);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setIndex(0);
    setLoaded(false);
  }, [song?.videoId, song?.thumbnail]);

  const src = candidates[index];
  const exhausted = !src;

  return (
    <div className={`relative overflow-hidden bg-surface-elevated ${className}`}>
      {!loaded && !exhausted && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-surface-elevated via-border/40 to-surface-elevated" />
      )}
      {src ? (
        <Image
          src={src}
          alt={alt || song?.title || ""}
          fill
          unoptimized
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setIndex((current) => current + 1);
          }}
          className={`object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted">
          <Music className={iconClassName} />
        </div>
      )}
    </div>
  );
}
