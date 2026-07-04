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
          <div key={i} className="h-4 bg-border/30 rounded" style={{ width: `${70 + Math.random() * 30}%` }} />
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
