import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Under Maintenance",
  description: "Strumm is currently undergoing maintenance.",
  robots: { index: false, follow: false },
};

export default function MaintenancePage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="text-center max-w-md mx-auto space-y-6 soft-enter">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-accent/10 border border-accent/20 mb-2">
          <svg className="w-10 h-10 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.58 5.58a2.121 2.121 0 01-3-3l5.58-5.58m5.58-5.58l5.58-5.58a2.121 2.121 0 013 3l-5.58 5.58M4.93 11.93l6.14 6.14M7.76 7.76l6.14 6.14" />
          </svg>
        </div>
        <h1 className="text-3xl font-editorial font-bold text-text">Under Maintenance</h1>
        <p className="text-sm text-muted leading-relaxed">
          Strumm is currently undergoing scheduled maintenance to improve your experience. We&apos;ll be back shortly.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/"
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition text-center min-w-[140px]"
          >
            Check Back
          </Link>
          <Link
            href="/status"
            className="px-6 py-2.5 border border-border hover:border-primary/50 text-text text-sm rounded-lg transition text-center min-w-[140px]"
          >
            Status Updates
          </Link>
        </div>
      </div>
    </div>
  );
}
