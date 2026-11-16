"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error("Strumm caught an application error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-4">
      <div className="reform-panel !rounded-[2rem] p-10 sm:p-12 max-w-lg w-full shadow-2xl flex flex-col items-center text-center space-y-8 animate-in fade-in zoom-in duration-500 relative overflow-hidden">
        <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl animate-pulse" />
          <div className="relative h-24 w-24 rounded-3xl bg-surface-elevated border-2 border-primary/30 flex items-center justify-center shadow-inner box-glow">
            <AlertTriangle className="w-11 h-11 text-primary" />
          </div>
        </div>
        
        <div className="space-y-3 relative">
          <span className="reform-chip mx-auto">System Glitch</span>
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-text">
            Something went wrong
          </h2>
          <p className="text-muted text-sm sm:text-base leading-relaxed font-medium">
            We encountered an unexpected glitch while rendering this space. Don&apos;t worry, your music is safe.
          </p>
        </div>

        <button
          onClick={() => reset()}
          className="group relative flex items-center justify-center gap-2 bg-primary text-background hover:bg-primary-hover transition-all duration-300 px-8 py-4 rounded-2xl font-extrabold uppercase tracking-wide shadow-[0_14px_34px_-16px_var(--glow)] active:scale-[0.98] w-full overflow-hidden cursor-pointer border border-primary"
        >
          <RefreshCw className="w-5 h-5 relative z-10 group-hover:rotate-180 transition-transform duration-500" />
          <span className="relative z-10">Try Again</span>
        </button>
      </div>
    </div>
  );
}
