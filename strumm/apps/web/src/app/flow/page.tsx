"use client";

import dynamic from "next/dynamic";
import { Sparkles, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useAuthStore } from "web/store/useAuthStore";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const AICuratorChat = dynamic(() => import("web/components/AICuratorChat"), {
  loading: () => (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  ),
  ssr: false,
});

export default function FlowPage() {
  const { token, user } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [token, router]);

  if (!token || !user) return null;

  return (
    <div className="space-y-6 max-w-5xl px-4 md:px-0 py-6 soft-enter">
      {/* Header / Breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/20 pb-4">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-2 hover:bg-surface-elevated text-muted hover:text-text rounded-lg transition flex items-center justify-center"
            title="Back to home"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block">
              AI Music Curation
            </span>
            <h1 className="text-3xl font-editorial text-text tracking-tight font-bold mt-0.5 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-primary animate-pulse" /> Strumm Flow
            </h1>
          </div>
        </div>
        <p className="text-xs text-muted max-w-sm sm:text-right">
          Build smart playlists, modify existing selections, and discover music curated by real AI intelligence.
        </p>
      </div>

      {/* Fullscreen AI Chat container */}
      <div className="bg-surface/10 border border-border/40 rounded-2xl p-2 md:p-6 shadow-xl backdrop-blur-lg">
        <AICuratorChat fullPage={true} />
      </div>
    </div>
  );
}
