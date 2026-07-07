"use client";

export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-3 w-20 bg-border/40 rounded" />
        <div className="h-8 w-48 bg-border/40 rounded" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 bg-border/30 rounded" style={{ width: `${70 + (i * 7) % 30}%` }} />
        ))}
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="p-4 rounded-lg border border-border/40 bg-surface/30 space-y-4 animate-pulse">
          <div className="w-full aspect-square rounded-lg bg-border/40" />
          <div className="space-y-2">
            <div className="h-4 w-3/4 rounded bg-border/50" />
            <div className="h-3 w-24 rounded bg-border/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SocialSkeleton() {
  return (
    <div className="space-y-6 animate-pulse max-w-6xl">
      <div className="space-y-2">
        <div className="h-3 w-28 bg-border/40 rounded" />
        <div className="h-8 w-36 bg-border/40 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-4 rounded-xl border border-border/40 bg-surface/30 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-border/40" />
                <div className="space-y-2 flex-1">
                  <div className="h-3 w-32 bg-border/40 rounded" />
                  <div className="h-2 w-20 bg-border/30 rounded" />
                </div>
              </div>
              <div className="h-10 rounded-lg bg-border/30" />
            </div>
          ))}
        </div>
        <div className="lg:col-span-4 space-y-4">
          <div className="p-5 rounded-2xl border border-border/40 bg-surface/30 space-y-4">
            <div className="h-5 w-28 bg-border/40 rounded" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-border/40" />
                <div className="h-3 w-24 bg-border/40 rounded flex-1" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlayerPageSkeleton() {
  return (
    <div className="animate-pulse space-y-6 max-w-6xl">
      <div className="flex flex-col md:flex-row items-center gap-6 p-6 rounded-2xl border border-border/40 bg-surface/30">
        <div className="w-32 h-32 rounded-xl bg-border/40" />
        <div className="flex-1 space-y-3 text-center md:text-left">
          <div className="h-3 w-24 bg-border/40 rounded mx-auto md:mx-0" />
          <div className="h-6 w-48 bg-border/40 rounded mx-auto md:mx-0" />
          <div className="h-4 w-32 bg-border/40 rounded mx-auto md:mx-0" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-4">
          <div className="p-6 rounded-2xl border border-border/40 bg-surface/30 space-y-4">
            <div className="h-5 w-36 bg-border/40 rounded" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-10 h-10 rounded bg-border/40" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-3/4 bg-border/40 rounded" />
                  <div className="h-2 w-1/2 bg-border/30 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-4 space-y-4">
          <div className="p-5 rounded-2xl border border-border/40 bg-surface/30 space-y-4">
            <div className="h-5 w-28 bg-border/40 rounded" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-border/40" />
                <div className="h-3 w-20 bg-border/40 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
