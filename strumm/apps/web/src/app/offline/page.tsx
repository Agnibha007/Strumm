import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Offline",
  description: "You're offline. Strumm can't reach its servers.",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="text-center max-w-md mx-auto space-y-6 soft-enter">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 border border-primary/20 mb-2">
          <svg className="w-10 h-10 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 010-7.07m-4.243 4.243a1 1 0 010-1.414" />
          </svg>
        </div>
        <h1 className="text-3xl font-editorial font-bold text-text">You&apos;re Offline</h1>
        <p className="text-sm text-muted leading-relaxed">
          It looks like you&apos;ve lost your internet connection. Strumm needs an active connection to stream music and access your library.
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-muted bg-surface-elevated border border-border/40 rounded-lg px-4 py-3">
          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          Waiting for connection...
        </div>
        <button
          onClick={() => window.location.reload()}
          className="inline-block px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition"
        >
          Try Reconnecting
        </button>
      </div>
    </div>
  );
}
