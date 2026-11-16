import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 — Page Not Found",
  description: "The page you are looking for does not exist on Strumm.",
};

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-4">
      <div className="reform-panel !rounded-[2rem] p-10 sm:p-12 max-w-lg w-full shadow-2xl flex flex-col items-center text-center space-y-8 soft-enter relative overflow-hidden">
        <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -left-12 -bottom-12 h-40 w-40 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl animate-pulse" />
          <div className="relative h-28 w-28 rounded-3xl bg-surface-elevated border-2 border-primary/30 flex items-center justify-center shadow-inner box-glow rotate-3">
            <span className="font-editorial text-5xl font-black text-primary text-glow">404</span>
          </div>
        </div>
        <div className="space-y-3 relative">
          <span className="reform-chip mx-auto">Lost Track</span>
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-text">Page Not Found</h2>
          <p className="text-muted text-sm sm:text-base leading-relaxed font-medium">This page does not exist or has been moved. Let&apos;s get you back to the music.</p>
        </div>
        <Link href="/" className="group relative flex items-center justify-center gap-2 bg-primary text-background transition-all duration-300 px-8 py-4 rounded-2xl font-extrabold uppercase tracking-wide shadow-[0_14px_34px_-16px_var(--glow)] hover:bg-primary-hover active:scale-[0.98] w-full overflow-hidden border border-primary">
          <span className="relative z-10">Return Home</span>
        </Link>
      </div>
    </div>
  );
}
