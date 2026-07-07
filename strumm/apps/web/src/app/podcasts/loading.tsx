import { CardGridSkeleton } from "web/components/PageSkeleton";

export default function Loading() {
  return (
    <div className="max-w-7xl px-4 py-8 space-y-6">
      <div className="space-y-2 animate-pulse">
        <div className="h-3 w-20 bg-border/40 rounded" />
        <div className="h-8 w-48 bg-border/40 rounded" />
      </div>
      <CardGridSkeleton count={8} />
    </div>
  );
}
