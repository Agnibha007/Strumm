export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl animate-pulse px-4 py-8 md:px-6">
      <div className="mb-6 h-4 w-20 rounded bg-muted" />
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="space-y-3">
          <div className="h-3 w-28 rounded bg-muted" />
          <div className="h-9 w-56 rounded bg-muted" />
        </div>
        <div className="h-10 w-28 rounded-xl bg-muted" />
      </div>
      <div className="mb-6 grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <div className="h-40 rounded-2xl border border-border bg-card" />
        <div className="h-40 rounded-2xl border border-border bg-card" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-80 rounded-2xl border border-border bg-card" />
        <div className="h-80 rounded-2xl border border-border bg-card" />
      </div>
    </main>
  );
}
