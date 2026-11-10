export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl animate-pulse px-4 py-10 md:px-6">
      <div className="mb-8 space-y-3">
        <div className="h-3 w-28 rounded bg-muted" />
        <div className="h-10 w-44 rounded bg-muted" />
        <div className="h-4 w-80 max-w-full rounded bg-muted" />
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        <div className="h-48 rounded-2xl border border-border bg-card" />
        <div className="h-48 rounded-2xl border border-border bg-card" />
      </div>
      <div className="mb-4 h-6 w-32 rounded bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-28 rounded-2xl border border-border bg-card" />
        <div className="h-28 rounded-2xl border border-border bg-card" />
      </div>
    </main>
  );
}
