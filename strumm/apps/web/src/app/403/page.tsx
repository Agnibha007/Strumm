import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "403 - Forbidden",
  description: "You don't have permission to access this page.",
  robots: { index: false, follow: false },
};

export default function ForbiddenPage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="reform-panel text-center max-w-lg mx-auto space-y-6 p-8 sm:p-10 soft-enter relative overflow-hidden">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-primary/15 blur-3xl" />
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/15 border-2 border-primary/30 mb-2 box-glow">
          <span className="text-4xl font-editorial font-black text-primary">403</span>
        </div>
        <span className="reform-chip mx-auto">Restricted</span>
        <h1 className="text-3xl sm:text-4xl font-editorial font-black text-text">Forbidden</h1>
        <p className="text-sm sm:text-base text-muted leading-relaxed font-medium">
          You don&apos;t have permission to access this page. If you believe this is a mistake, please contact support.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/"
            className="px-6 py-3 bg-primary hover:bg-primary-hover text-background text-sm font-extrabold uppercase tracking-wide rounded-xl transition text-center min-w-[160px] border border-primary shadow-[0_12px_30px_-16px_var(--glow)]"
          >
            Go Home
          </Link>
          <Link
            href="/contact"
            className="px-6 py-3 border-2 border-border hover:border-primary/50 hover:text-primary text-text text-sm font-bold rounded-xl transition text-center min-w-[160px] bg-surface/40"
          >
            Contact Support
          </Link>
        </div>
      </div>
    </div>
  );
}
