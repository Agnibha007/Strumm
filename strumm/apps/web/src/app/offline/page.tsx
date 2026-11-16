import type { Metadata } from "next";
import ReloadButton from "./ReloadButton";

export const metadata: Metadata = {
  title: "Offline",
  description: "You're offline. Saved songs and podcast episodes remain available in Downloads.",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="reform-panel text-center max-w-lg mx-auto space-y-6 p-8 sm:p-10 soft-enter relative overflow-hidden">
        <div className="absolute -left-10 -bottom-10 h-36 w-36 rounded-full bg-accent/10 blur-3xl" />
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/15 border-2 border-primary/30 mb-2 box-glow">
          <svg className="w-10 h-10 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 010-7.07m-4.243 4.243a1 1 0 010-1.414" />
          </svg>
        </div>
        <span className="reform-chip mx-auto">No Connection</span>
        <h1 className="text-3xl sm:text-4xl font-editorial font-black text-text">You&apos;re Offline</h1>
        <p className="text-sm sm:text-base text-muted leading-relaxed font-medium">
          Streaming music and episodes you haven&apos;t saved need an internet connection. Songs and podcast episodes downloaded to this device can still be played offline.
        </p>
        <a
          href="/downloads"
          className="inline-flex items-center justify-center rounded-xl bg-primary px-6 py-3 text-sm font-extrabold uppercase tracking-wide text-background transition hover:bg-primary-hover border border-primary shadow-[0_12px_30px_-16px_var(--glow)]"
        >
          Open Downloads
        </a>
        <div className="flex items-center justify-center gap-2 text-xs text-muted bg-surface-elevated/60 border border-border/60 rounded-xl px-4 py-3 font-semibold">
          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          Waiting for connection...
        </div>
        <ReloadButton />
      </div>
    </div>
  );
}
