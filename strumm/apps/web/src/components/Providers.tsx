"use client";

import { SessionProvider } from "next-auth/react";
import { MotionConfig } from "framer-motion";
import { useEffect } from "react";
import { useAuthStore } from "web/store/useAuthStore";
import { useThemeStore } from "web/store/useThemeStore";
import { mostVisitedSongs, prefetchSongMetadata } from "web/lib/api";

export default function Providers({ children }: { children: React.ReactNode }) {
  const isAnimated = useThemeStore((state) => state.isAnimated);
  const { user } = useAuthStore();

  // Prefetch the metadata for the songs the user has visited most recently.
  // This runs once on mount, in the background, and never blocks first paint.
  useEffect(() => {
    async function warmCache() {
      const ids = mostVisitedSongs();
      if (ids.length === 0 || !user) return;
      try {
        await prefetchSongMetadata(ids);
      } catch {
        // Network or timeout — the next navigation will retry.
      }
    }

    void warmCache();
  }, [user]);

  return (
    <SessionProvider>
      {/*
       * "user" (not "never") is the important part: when the app-level animation
       * preference is on, framer-motion still defers to the OS
       * `prefers-reduced-motion` setting. Previously this was "never", which
       * forced animations back ON for users who had asked the OS to reduce
       * motion — the app preference overrode the accessibility preference.
       * "always" is still used when the user turns animations off here.
       */}
      <MotionConfig reducedMotion={isAnimated ? "user" : "always"}>{children}</MotionConfig>
    </SessionProvider>
  );
}
