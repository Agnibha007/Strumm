import { SocialSkeleton } from "web/components/PageSkeleton";

export default function Loading() {
  return (
    <div className="max-w-6xl px-4 md:px-0 py-8">
      <SocialSkeleton />
    </div>
  );
}
