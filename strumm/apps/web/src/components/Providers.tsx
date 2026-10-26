"use client";

import { SessionProvider } from "next-auth/react";
import { MotionConfig } from "framer-motion";
import { useThemeStore } from "web/store/useThemeStore";

export default function Providers({ children }: { children: React.ReactNode }) {
  const isAnimated = useThemeStore((s) => s.isAnimated);

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
