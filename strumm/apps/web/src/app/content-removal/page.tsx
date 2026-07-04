import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Content Removal Policy",
  description: "Strumm Content Removal Policy — request removal of content from the platform.",
  openGraph: {
    title: "Content Removal Policy | Strumm",
    description: "Learn how to request removal of content from Strumm.",
  },
};

export default function ContentRemovalPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <div className="mb-10">
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight">Content Removal Policy</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted">
          <span>Effective: July 1, 2026</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>Last updated: July 3, 2026</span>
        </div>
      </div>

      <div className="space-y-10">
        <p className="text-sm text-muted leading-relaxed">
          Strumm is committed to providing a safe and respectful environment for all users. This policy outlines the types of content that may be removed and the process for requesting removal.
        </p>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Content We May Remove</h2>
          <p className="text-sm text-muted leading-relaxed mb-2">We reserve the right to remove, and will investigate requests to remove, the following types of content:</p>
          <ul className="list-disc pl-6 space-y-2 text-sm text-muted leading-relaxed">
            <li>Copyright-infringing material (see our <Link href="/dmca" className="text-primary hover:underline">DMCA Policy</Link> for formal takedown procedures)</li>
            <li>Harassing, abusive, or threatening content directed at other users</li>
            <li>Hate speech, discriminatory content, or content promoting violence</li>
            <li>Explicit, pornographic, or sexually suggestive content</li>
            <li>Misinformation or deceptive content</li>
            <li>Spam, automated content, or content designed to manipulate the platform</li>
            <li>Personal information posted without consent (doxxing)</li>
            <li>Content that violates applicable laws or regulations</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">How to Request Content Removal</h2>
          <p className="text-sm text-muted leading-relaxed mb-2">If you believe content on Strumm violates this policy, you may submit a removal request. Please include:</p>
          <ol className="list-decimal pl-6 space-y-2 text-sm text-muted leading-relaxed">
            <li>A clear description of the content you want removed (include URLs, playlist IDs, or usernames where possible).</li>
            <li>The specific reason for removal (harassment, copyright, hate speech, etc.).</li>
            <li>Your contact information (email address).</li>
            <li>If reporting on behalf of someone else, your relationship to the affected party.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Submit a Removal Request</h2>
          <div className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-2">
            <p className="text-sm font-semibold text-text">Send removal requests to:</p>
            <p className="text-xs text-muted">Email: <a href="mailto:abuse@strumm.me" className="text-primary hover:underline">abuse@strumm.me</a></p>
            <p className="text-xs text-muted">Please include &ldquo;Content Removal Request&rdquo; in the subject line.</p>
            <p className="text-xs text-muted">We aim to respond within 48 hours.</p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">User-Generated Content</h2>
          <p className="text-sm text-muted leading-relaxed">Strumm users can create playlists, song memories, and public profiles. If you see a playlist or profile containing inappropriate content, please report it using the contact information above.</p>
          <p className="text-sm text-muted leading-relaxed mt-3">Users may also delete their own content at any time. Playlists can be edited or deleted from the playlist view. Song memories can be deleted from Profile settings. Full account deletion is available via Profile → Account Control.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Process</h2>
          <p className="text-sm text-muted leading-relaxed">Upon receiving a valid removal request, we will:</p>
          <ol className="list-decimal pl-6 space-y-2 mt-3 text-sm text-muted leading-relaxed">
            <li>Acknowledge receipt within 48 hours.</li>
            <li>Review the content against this policy and applicable law.</li>
            <li>Take appropriate action (remove, restrict, or decline with explanation).</li>
            <li>Notify the requester and, where applicable, the content poster.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Contact</h2>
          <p className="text-sm text-muted leading-relaxed">For content removal inquiries: <a href="mailto:abuse@strumm.me" className="text-primary hover:underline">abuse@strumm.me</a></p>
        </section>
      </div>

      <div className="mt-16 pt-8 border-t border-border/40">
        <Link href="/privacy" className="text-sm text-primary hover:underline">Privacy Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/terms" className="text-sm text-primary hover:underline">Terms of Service</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/dmca" className="text-sm text-primary hover:underline">DMCA Policy</Link>
      </div>
    </div>
  );
}
