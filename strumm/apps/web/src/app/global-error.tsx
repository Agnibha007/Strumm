"use client";

import * as Sentry from "@sentry/nextjs";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased min-h-screen selection:bg-primary/30">
        <div className="flex flex-col items-center justify-center min-h-screen px-4">
          <div className="reform-panel !rounded-[2rem] p-10 sm:p-12 max-w-lg w-full shadow-2xl flex flex-col items-center text-center space-y-8 relative overflow-hidden">
            <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
            <div className="relative">
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl animate-pulse" />
              <div className="relative h-24 w-24 rounded-3xl bg-surface-elevated border-2 border-primary/30 flex items-center justify-center shadow-inner box-glow">
                <AlertTriangle className="w-11 h-11 text-primary" />
              </div>
            </div>
            
            <div className="space-y-3 relative">
              <span className="reform-chip mx-auto">Critical Error</span>
              <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-text">
                Fatal Error
              </h2>
              <p className="text-muted text-sm sm:text-base leading-relaxed font-medium">
                Strumm encountered a critical error while loading the application shell. Please refresh to restart.
              </p>
            </div>

            <button
              onClick={() => reset()}
              className="group relative flex items-center justify-center gap-2 bg-primary text-background hover:bg-primary-hover transition-all duration-300 px-8 py-4 rounded-2xl font-extrabold uppercase tracking-wide shadow-[0_14px_34px_-16px_var(--glow)] active:scale-[0.98] w-full overflow-hidden cursor-pointer border border-primary"
            >
              <RefreshCw className="w-5 h-5 relative z-10 group-hover:rotate-180 transition-transform duration-500" />
              <span className="relative z-10">Restart App</span>
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
