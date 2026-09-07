"use client";

import { useLastPlayedPlaylistStore } from "web/store/useLastPlayedPlaylistStore";
import { Clock, Play, ChevronRight } from "lucide-react";
import Link from "next/link";

export default function RecentlyPlayedPlaylist() {
  const lastPlayed = useLastPlayedPlaylistStore((s) => s.lastPlayed);

  if (!lastPlayed) return null;

  return (
    <section aria-label="Most recently played playlist">
      <div className="space-y-3">
        <header className="flex items-center justify-between border-b border-border/20 pb-2">
          <h2 className="font-editorial text-2xl text-text font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Jump Back In
          </h2>
          <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">Pick up where you left off</span>
        </header>

        <Link
          href={`/playlist/${lastPlayed.id}`}
          className="group flex items-center gap-4 p-3 bg-surface/40 border border-border/40 hover:bg-surface hover:border-border/80 rounded-xl transition cursor-pointer"
        >
          <figure className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 relative m-0 shadow">
            {lastPlayed.coverUrl ? (
              <img src={lastPlayed.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (              <div className="w-full h-full bg-border/40 flex items-center justify-center">
                <Play className="w-5 h-5 text-primary fill-current" />
              </div>
            )}
          </figure>
          <div className="min-w-0 flex-grow">
            <div className="text-[10px] uppercase tracking-wider text-muted font-semibold">Recently played</div>
            <div className="font-editorial text-base font-bold text-text truncate group-hover:text-primary transition">
              {lastPlayed.name}
            </div>
            <div className="text-xs text-muted">{lastPlayed.songCount} song{lastPlayed.songCount === 1 ? "" : "s"}</div>
          </div>
          <ChevronRight className="w-5 h-5 text-muted group-hover:text-primary transition flex-shrink-0" />
        </Link>
      </div>
    </section>
  );
}
