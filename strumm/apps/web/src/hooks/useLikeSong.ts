import { useEffect, useState } from "react";
import type { Song } from "@strumm/types";
import { apiFetch } from "web/lib/api-client";

export function useLikeSong(videoId: string | undefined, token: string | null) {
  const [isLiked, setIsLiked] = useState(false);

  useEffect(() => {
    if (!videoId || !token) {
      setIsLiked(false);
      return;
    }

    let cancelled = false;

    apiFetch<{ liked: boolean }>(`/liked/${videoId}`, { token })
      .then((data) => {
        if (!cancelled) setIsLiked(data.liked);
      })
      .catch(() => {
        if (!cancelled) setIsLiked(false);
      });

    return () => {
      cancelled = true;
    };
  }, [videoId, token]);

  const toggleLike = async (song: Song) => {
    if (!token) return;
    const data = await apiFetch<{ liked: boolean }>("/liked", {
      method: "POST",
      token,
      body: JSON.stringify(song),
    });
    setIsLiked(data.liked);
  };

  return { isLiked, toggleLike };
}
