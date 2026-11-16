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
      <div className="reform-panel text-center max-w-lg mx-auto space-y-6 p-8 sm:p-10 soft-enter relative overflow-hidden">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-accent/15 blur-3xl" />
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-accent/15 border-2 border-accent/30 mb-2 box-glow">
          <svg className="w-10 h-10 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.58 5.58a2.121 2.121 0 01-3-3l5.58-5.58m5.58-5.58l5.58-5.58a2.121 2.121 0 013 3l-5.58 5.58M4.93 11.93l6.14 6.14M7.76 7.76l6.14 6.14" />
          </svg>
        </div>
        <span className="reform-chip mx-auto">Scheduled Work</span>
        <h1 className="text-3xl sm:text-4xl font-editorial font-black text-text">Under Maintenance</h1>
        <p className="text-sm sm:text-base text-muted leading-relaxed font-medium max-w-md mx-auto">
          Strumm is currently undergoing scheduled maintenance to improve your experience. We&apos;ll be back shortly.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/"
            className="px-6 py-3 bg-primary hover:bg-primary-hover text-background text-sm font-extrabold uppercase tracking-wide rounded-xl transition text-center min-w-[160px] border border-primary shadow-[0_12px_30px_-16px_var(--glow)]"
          >
            Check Back
          </Link>
          <Link
            href="/status"
            className="px-6 py-3 border-2 border-border hover:border-primary/50 hover:text-primary text-text text-sm font-bold rounded-xl transition text-center min-w-[160px] bg-surface/40"
          >
            Status Updates
          </Link>
        </div>
      </div>
    </div>
  );
}
