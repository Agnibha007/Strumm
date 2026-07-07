import { Metadata } from "next";
import Link from "next/link";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

export const metadata: Metadata = {
  title: "DMCA Policy",
  description: "Strumm DMCA / Copyright Policy — how to report copyright infringement.",
  openGraph: {
    title: "DMCA Policy | Strumm",
    description: "Submit a DMCA takedown notice for alleged copyright infringement on Strumm.",
  },
};

export default function DMCAPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "DMCA Policy", href: "/dmca" },
      ]} />
    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <div className="mb-10">
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight">DMCA & Copyright Policy</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted">
          <span>Effective: July 1, 2026</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>Last updated: July 3, 2026</span>
        </div>
      </div>

      <div className="space-y-10">
        <p className="text-sm text-muted leading-relaxed">
          Strumm respects the intellectual property rights of others and expects its users to do the same. In accordance with the Digital Millennium Copyright Act (DMCA), we will respond promptly to notices of alleged copyright infringement.
        </p>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">How Strumm Handles Copyrighted Content</h2>
          <p className="text-sm text-muted leading-relaxed">Strumm does not host, store, or distribute audio or video files. All music content is streamed via YouTube&apos;s iframe API. If a song violates your copyright on YouTube, please submit a takedown notice directly to YouTube via their <Link href="https://support.google.com/youtube/answer/2807622" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Copyright Center</Link>.</p>
          <p className="text-sm text-muted leading-relaxed">However, if you believe that your copyrighted work is being infringed upon through the Strumm platform itself (e.g., playlist descriptions, user-generated content, or podcast metadata), please submit a DMCA notice to our designated agent.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Filing a DMCA Notice</h2>
          <p className="text-sm text-muted leading-relaxed mb-2">To file a DMCA takedown notice, please provide the following information in writing:</p>
          <ol className="list-decimal pl-6 space-y-2 text-sm text-muted leading-relaxed">
            <li>Your physical or electronic signature (typing your full name counts as an electronic signature).</li>
            <li>Identification of the copyrighted work you claim has been infringed.</li>
            <li>Identification of the material that is infringing and sufficient information to locate it (e.g., a playlist URL, song video ID, or podcast show ID).</li>
            <li>Your name, mailing address, telephone number, and email address.</li>
            <li>A statement that you have a good faith belief that the use is not authorized by the copyright owner, its agent, or the law.</li>
            <li>A statement, under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorized to act on their behalf.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Submit Your Notice</h2>
          <div className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-2">
            <p className="text-sm font-semibold text-text">Designated DMCA Agent</p>
            <p className="text-xs text-muted">Email: <a href="mailto:dmca@strumm.me" className="text-primary hover:underline">dmca@strumm.me</a></p>
            <p className="text-xs text-muted">Please include &ldquo;DMCA Notice&rdquo; in the subject line.</p>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Counter-Notice</h2>
          <p className="text-sm text-muted leading-relaxed">If you believe that material you posted was removed or disabled by mistake or misidentification, you may submit a counter-notice. Your counter-notice must include:</p>
          <ol className="list-decimal pl-6 space-y-2 mt-3 text-sm text-muted leading-relaxed">
            <li>Your physical or electronic signature.</li>
            <li>Identification of the material that was removed and where it was located before removal.</li>
            <li>A statement, under penalty of perjury, that you have a good faith belief the material was removed as a result of mistake or misidentification.</li>
            <li>Your name, address, and telephone number, and a statement consenting to the jurisdiction of the federal district court for the judicial district in which your address is located.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Repeat Infringer Policy</h2>
          <p className="text-sm text-muted leading-relaxed">Strumm reserves the right to terminate the accounts of users who are determined to be repeat infringers of copyrighted content.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Contact</h2>
          <p className="text-sm text-muted leading-relaxed">For DMCA inquiries: <a href="mailto:dmca@strumm.me" className="text-primary hover:underline">dmca@strumm.me</a></p>
        </section>
      </div>

      <div className="mt-16 pt-8 border-t border-border/40">
        <Link href="/privacy" className="text-sm text-primary hover:underline">Privacy Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/terms" className="text-sm text-primary hover:underline">Terms of Service</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/content-removal" className="text-sm text-primary hover:underline">Content Removal Policy</Link>
      </div>
    </div>
    </>
  );
}
