import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 — Page Not Found",
  description: "The page you are looking for does not exist on Strumm.",
};

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] px-4">
      <div className="bg-surface/50 backdrop-blur-xl border border-border/40 p-10 rounded-[2rem] max-w-md w-full shadow-2xl flex flex-col items-center text-center space-y-8 soft-enter">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/10 rounded-full blur-2xl animate-pulse" />
          <div className="relative h-24 w-24 rounded-full bg-surface-elevated border border-border/60 flex items-center justify-center shadow-inner">
            <span className="font-editorial text-5xl font-bold text-primary">404</span>
          </div>
        </div>
        <div className="space-y-3">
          <h2 className="text-3xl font-bold tracking-tight text-text">Page Not Found</h2>
          <p className="text-muted text-sm leading-relaxed">This page does not exist or has been moved. Let&apos;s get you back to the music.</p>
        </div>
        <Link href="/" className="group relative flex items-center justify-center space-x-2 bg-primary text-white transition-all duration-300 px-8 py-4 rounded-full font-semibold shadow-lg hover:shadow-xl hover:bg-primary-hover active:scale-95 w-full overflow-hidden">
          <span className="relative z-10">Return Home</span>
        </Link>
      </div>
    </div>
  );
}
