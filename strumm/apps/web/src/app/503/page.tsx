import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "503 - Service Unavailable",
  description: "Strumm is temporarily unavailable. Please try again shortly.",
  robots: { index: false, follow: false },
};

export default function ServiceUnavailablePage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="text-center max-w-md mx-auto space-y-6 soft-enter">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 border border-primary/20 mb-2">
          <span className="text-4xl font-editorial font-bold text-primary">503</span>
        </div>
        <h1 className="text-3xl font-editorial font-bold text-text">Service Unavailable</h1>
        <p className="text-sm text-muted leading-relaxed">
          Strumm is temporarily unavailable due to maintenance or a brief outage. Please try again in a few moments.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/"
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition text-center min-w-[140px]"
          >
            Try Again
          </Link>
          <Link
            href="/status"
            className="px-6 py-2.5 border border-border hover:border-primary/50 text-text text-sm rounded-lg transition text-center min-w-[140px]"
          >
            Service Status
          </Link>
        </div>
      </div>
    </div>
  );
}
