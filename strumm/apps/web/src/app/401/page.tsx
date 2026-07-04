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
      <div className="text-center max-w-md mx-auto space-y-6 soft-enter">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 border border-primary/20 mb-2">
          <span className="text-4xl font-editorial font-bold text-primary">401</span>
        </div>
        <h1 className="text-3xl font-editorial font-bold text-text">Unauthorized</h1>
        <p className="text-sm text-muted leading-relaxed">
          You need to sign in to access this page. If you already have an account, please log in to continue.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            href="/login"
            className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white font-editorial text-sm font-bold rounded-lg transition text-center min-w-[140px]"
          >
            Sign In
          </Link>
          <Link
            href="/"
            className="px-6 py-2.5 border border-border hover:border-primary/50 text-text text-sm rounded-lg transition text-center min-w-[140px]"
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
