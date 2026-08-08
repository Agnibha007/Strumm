"use client";

import { SessionProvider } from "next-auth/react";
import { MotionConfig } from "framer-motion";
import { useThemeStore } from "web/store/useThemeStore";

export default function Providers({ children }: { children: React.ReactNode }) {
  const isAnimated = useThemeStore((s) => s.isAnimated);

  return (
    <SessionProvider>
      <MotionConfig reducedMotion={isAnimated ? "never" : "always"}>{children}</MotionConfig>
    </SessionProvider>
  );
}
