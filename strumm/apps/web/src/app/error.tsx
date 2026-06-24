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
      <div className="bg-surface/50 backdrop-blur-xl border border-border/40 p-10 rounded-[2rem] max-w-md w-full shadow-2xl flex flex-col items-center text-center space-y-8 animate-in fade-in zoom-in duration-500">
        <div className="relative">
          <div className="absolute inset-0 bg-destructive/20 rounded-full blur-2xl animate-pulse" />
          <div className="relative h-24 w-24 rounded-full bg-surface-elevated border border-border/60 flex items-center justify-center shadow-inner">
            <AlertTriangle className="w-12 h-12 text-destructive" />
          </div>
        </div>
        
        <div className="space-y-3">
          <h2 className="text-3xl font-bold tracking-tight bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-transparent">
            Something went wrong
          </h2>
          <p className="text-muted/90 text-sm leading-relaxed">
            We encountered an unexpected glitch while rendering this space. Don&apos;t worry, your music is safe.
          </p>
        </div>

        <button
          onClick={() => reset()}
          className="group relative flex items-center justify-center space-x-2 bg-foreground text-background hover:bg-foreground/90 transition-all duration-300 px-8 py-4 rounded-full font-semibold shadow-lg hover:shadow-xl active:scale-95 w-full overflow-hidden"
        >
          <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
          <RefreshCw className="w-5 h-5 relative z-10 group-hover:rotate-180 transition-transform duration-500" />
          <span className="relative z-10">Try Again</span>
        </button>
      </div>
    </div>
  );
}
