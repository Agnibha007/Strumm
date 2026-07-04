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
      <div className="text-center max-w-md mx-auto space-y-6 soft-enter">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 border border-primary/20 mb-2">
          <span className="text-4xl font-editorial font-bold text-primary">429</span>
        </div>
        <h1 className="text-3xl font-editorial font-bold text-text">Too Many Requests</h1>
        <p className="text-sm text-muted leading-relaxed">
          You&apos;ve made too many requests in a short period. Please wait a moment before trying again.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
