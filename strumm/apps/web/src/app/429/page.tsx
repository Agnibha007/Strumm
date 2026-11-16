import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "429 - Too Many Requests",
  description: "You've been rate limited. Please slow down.",
  robots: { index: false, follow: false },
};

export default function RateLimitedPage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="reform-panel text-center max-w-lg mx-auto space-y-6 p-8 sm:p-10 soft-enter relative overflow-hidden">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/15 border-2 border-primary/30 mb-2 box-glow">
          <span className="text-4xl font-editorial font-black text-primary">429</span>
        </div>
        <span className="reform-chip mx-auto">Slow Down</span>
        <h1 className="text-3xl sm:text-4xl font-editorial font-black text-text">Too Many Requests</h1>
        <p className="text-sm sm:text-base text-muted leading-relaxed font-medium">
          You&apos;ve made too many requests in a short period. Please wait a moment before trying again.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-primary hover:bg-primary-hover text-background font-extrabold uppercase tracking-wide text-sm rounded-xl transition border border-primary shadow-[0_12px_30px_-16px_var(--glow)]"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
