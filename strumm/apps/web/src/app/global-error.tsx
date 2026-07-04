"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import "./globals.css";

export default function GlobalError({
  reset,
}: {
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased min-h-screen selection:bg-primary/30">
        <div className="flex flex-col items-center justify-center min-h-screen px-4">
          <div className="bg-surface/40 backdrop-blur-2xl border border-border/40 p-10 rounded-[2rem] max-w-md w-full shadow-2xl flex flex-col items-center text-center space-y-8">
            <div className="relative">
              <div className="absolute inset-0 bg-primary/10 rounded-full blur-2xl animate-pulse" />
              <div className="relative h-24 w-24 rounded-full bg-surface-elevated border border-border/60 flex items-center justify-center shadow-inner">
                <AlertTriangle className="w-12 h-12 text-primary" />
              </div>
            </div>
            
            <div className="space-y-3">
              <h2 className="text-3xl font-bold tracking-tight text-text">
                Fatal Error
              </h2>
              <p className="text-muted/90 text-sm leading-relaxed">
                Strumm encountered a critical error while loading the application shell. Please refresh to restart.
              </p>
            </div>

            <button
              onClick={() => reset()}
              className="group relative flex items-center justify-center space-x-2 bg-primary text-white hover:bg-primary-hover transition-all duration-300 px-8 py-4 rounded-full font-semibold shadow-lg hover:shadow-xl active:scale-95 w-full overflow-hidden cursor-pointer"
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
              <RefreshCw className="w-5 h-5 relative z-10 group-hover:rotate-180 transition-transform duration-500" />
              <span className="relative z-10">Restart App</span>
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
