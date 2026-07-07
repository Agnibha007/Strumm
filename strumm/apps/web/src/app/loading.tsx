export default function RootLoading() {
  return (
    <div className="max-w-7xl px-4 py-8 space-y-8">
      {/* Branded header skeleton */}
      <div className="space-y-4 animate-pulse">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-primary/30" />
          <div className="h-5 w-24 bg-primary/20 rounded" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-28 bg-border/40 rounded" />
          <div className="h-10 w-72 bg-border/30 rounded" />
        </div>
      </div>

      {/* Search bar skeleton */}
      <div className="animate-pulse">
        <div className="h-12 w-full bg-border/20 rounded-xl" />
      </div>

      {/* Two-column content skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-pulse">
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-border/20 pb-2">
            <div className="w-5 h-5 rounded bg-primary/30" />
            <div className="h-5 w-32 bg-border/40 rounded" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-3 rounded-xl bg-surface/30 border border-border/40 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded bg-border/40" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-3/4 bg-border/40 rounded" />
                    <div className="h-2 w-1/2 bg-border/30 rounded" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-border/20 pb-2">
            <div className="w-5 h-5 rounded bg-red-500/30" />
            <div className="h-5 w-36 bg-border/40 rounded" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg">
                <div className="w-10 h-10 rounded bg-border/40" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-3/4 bg-border/40 rounded" />
                  <div className="h-2 w-1/3 bg-border/30 rounded" />
                </div>
                <div className="w-4 h-4 rounded bg-border/20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
