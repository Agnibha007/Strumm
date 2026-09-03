import { useCallback, useEffect, useState } from "react";
import { getAvatarUrl } from "web/lib/media-api";
import type { User } from "@strumm/types";

/**
 * Resolve a user's avatar to a renderable `<img src=...>` string.
 *
 * - Legacy avatars (`user.avatar` = base64 `data:` URI or external URL) are
 *   returned directly — no network round-trip.
 * - B2-backed avatars (`user.avatarMediaId`) resolve to a short-lived presigned
 *   URL from the owner-only `/media/avatar-url` endpoint. Results are cached
 *   in memory keyed by `avatarMediaId` and silently refreshed near expiry, so
 *   the *persistent* current-user avatar (which outlives page rehydration)
 *   never renders an expired URL.
 *
 * Lists of other users do NOT use this hook — their avatars come already
 * signed (batched) inside the response via the backend avatar resolver.
 */
const cache = new Map<
  string,
  { url: string; expiresAt: number; inFlight: Promise<string | null> | null }
>();
const AVATAR_REFRESH_MARGIN_MS = 30_000;

function readCache(key: string) {
  return cache.get(key);
}

async function fetchOrWait(key: string): Promise<string | null> {
  const entry = readCache(key);
  if (entry && entry.inFlight) return entry.inFlight;
  const newEntry: { url: string; expiresAt: number; inFlight: Promise<string | null> | null } = {
    url: "",
    expiresAt: 0,
    inFlight: Promise.resolve<string | null>(null),
  };
  cache.set(key, newEntry);
  newEntry.inFlight = (async () => {
    try {
      const res = await getAvatarUrl(key);
      const expiresInMs = Math.max(res.expiresIn * 1000, 0);
      newEntry.url = res.url;
      newEntry.expiresAt = Date.now() + expiresInMs;
      return res.url;
    } catch {
      return null;
    } finally {
      newEntry.inFlight = null;
    }
  })();
  return newEntry.inFlight;
}

export function useUserAvatar(user: Pick<User, "avatarMediaId" | "avatar"> | null | undefined): string | null {
  const mediaId = user?.avatarMediaId;

  const load = useCallback(async (key: string) => {
    const existing = readCache(key);
    if (existing && existing.url && existing.expiresAt > Date.now() + AVATAR_REFRESH_MARGIN_MS) {
      return existing.url;
    }
    return fetchOrWait(key);
  }, []);

  const [url, setUrl] = useState<string | null>(() =>
    mediaId
      ? (readCache(mediaId)?.url ?? null)
      : (user?.avatar ?? null),
  );

  useEffect(() => {
    if (!mediaId) {
      setUrl(user?.avatar ?? null);
      return;
    }
    let mounted = true;
    load(mediaId).then((resolved) => {
      if (mounted && resolved) setUrl(resolved);
    });
    return () => {
      mounted = false;
    };
  }, [mediaId, user?.avatar, load]);

  return url;
}