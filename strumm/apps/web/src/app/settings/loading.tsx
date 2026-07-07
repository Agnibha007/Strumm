import { PageSkeleton } from "web/components/PageSkeleton";

export default function Loading() {
  return (
    <div className="max-w-3xl px-4 py-8">
      <PageSkeleton rows={6} />
    </div>
  );
}
