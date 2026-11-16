import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "401 - Unauthorized",
  description: "You need to sign in to access this page.",
  robots: { index: false, follow: false },
};

export default function UnauthorizedPage() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6">
      <div className="reform-panel text-center max-w-lg mx-auto space-y-6 p-8 sm:p-10 soft-enter relative overflow-hidden">
        <div className="absolute -left-10 -top-10 h-36 w-36 rounded-full bg-primary/15 blur-3xl" />
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/15 border-2 border-primary/30 mb-2 box-glow">
          <span className="text-4xl font-editorial font-black text-primary">401</span>
        </div>
        <span className="reform-chip mx-auto">Access Required</span>
        <h1 className="text-3xl sm:text-4xl font-editorial font-black text-text">Unauthorized</h1>
        <p className="text-sm sm:text-base text-muted leading-relaxed font-medium">
          You need to sign in to access this page. If you already have an account, please log in to continue.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/login"
            className="px-6 py-3 bg-primary hover:bg-primary-hover text-background text-sm font-extrabold uppercase tracking-wide rounded-xl transition text-center min-w-[160px] border border-primary shadow-[0_12px_30px_-16px_var(--glow)]"
          >
            Sign In
          </Link>
          <Link
            href="/"
            className="px-6 py-3 border-2 border-border hover:border-primary/50 hover:text-primary text-text text-sm font-bold rounded-xl transition text-center min-w-[160px] bg-surface/40"
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
