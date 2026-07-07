import { PageSkeleton } from "web/components/PageSkeleton";

export default function Loading() {
  return (
    <div className="max-w-7xl px-4 py-8">
      <PageSkeleton rows={5} />
    </div>
  );
}
