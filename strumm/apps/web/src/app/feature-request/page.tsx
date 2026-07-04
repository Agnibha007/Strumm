import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Feature Request",
  description: "Suggest a feature for Strumm.",
};

export default function FeatureRequestPage() {
  return (
    <main className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Community</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Feature Request</h1>
      <p className="text-sm text-muted mb-8">Have an idea to make Strumm better? We would love to hear it.</p>
      <div className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-5">
        <p className="text-sm text-muted leading-relaxed">Before submitting, check our <Link href="/roadmap" className="text-primary hover:underline">Roadmap</Link> to see if your idea is already planned.</p>
        <p className="text-sm text-muted leading-relaxed">Please include a clear description of the feature, why it would be useful, and any examples of how it would work.</p>
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">Send feature requests to:</p>
          <a href="mailto:feedback@strumm.me" className="text-sm text-primary hover:underline font-semibold">feedback@strumm.me</a>
        </div>
      </div>
    </main>
  );
}
