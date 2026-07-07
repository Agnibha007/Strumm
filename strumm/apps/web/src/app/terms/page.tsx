import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Strumm Terms of Service — the rules and guidelines for using the Strumm music platform.",
  openGraph: {
    title: "Terms of Service | Strumm",
    description: "Please read these terms carefully before using Strumm.",
  },
};

const sections = [
  {
    title: "Acceptance of Terms",
    content: (
      <p className="text-sm text-muted leading-relaxed">By accessing or using Strumm (&ldquo;the Service&rdquo;), you agree to be bound by these Terms of Service. If you do not agree, you may not access or use the Service. We reserve the right to update these terms at any time; continued use constitutes acceptance of the changes.</p>
    ),
  },
  {
    title: "Description of Service",
    content: (
      <>
        <p className="mb-4 text-sm text-muted leading-relaxed">Strumm is a music streaming ecosystem that provides:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li>Music playback via YouTube&apos;s iframe API and audio streaming</li>
          <li>Playlist creation, curation, and sharing</li>
          <li>AI-powered music recommendations and discovery (powered by Groq AI when available)</li>
          <li>Synced lyrics display</li>
          <li>Podcast playback and subscription</li>
          <li>Listening statistics and personalized analytics (Strumm Replay, Sound DNA)</li>
          <li>Social features including Circles (friend connections), collaborative rooms, and blend playlists</li>
          <li>Cross-device player state synchronization</li>
          <li>Customizable theme engine</li>
        </ul>
      </>
    ),
  },
  {
    title: "User Accounts & Registration",
    content: (
      <>
        <p className="mb-4 text-sm text-muted leading-relaxed">To use Strumm, you must create an account. You agree to:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li>Provide accurate, current, and complete registration information</li>
          <li>Maintain the security of your login credentials</li>
          <li>Accept responsibility for all activity under your account</li>
          <li>Notify us immediately of any unauthorized access</li>
        </ul>
        <p className="text-sm text-muted leading-relaxed">You may register using email/password authentication or Google OAuth. Passwords are hashed using bcrypt and are never stored in plaintext.</p>
      </>
    ),
  },
  {
    title: "User Conduct",
    content: (
      <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
        <li>You may not use the Service for any unlawful purpose or in violation of any applicable laws.</li>
        <li>You may not attempt to circumvent rate limits, authentication mechanisms, or security controls.</li>
        <li>You may not scrape, copy, or reproduce content from the Service without authorization.</li>
        <li>You may not upload copyrighted material without the rights to do so.</li>
        <li>You may not harass, abuse, or harm other users through the social features.</li>
      </ul>
    ),
  },
  {
    title: "Intellectual Property",
    content: (
      <>
        <p className="mb-4 text-sm text-muted leading-relaxed">The Strumm name, logo, brand, and interface design are proprietary. The software is licensed under the MIT License.</p>
        <p className="mb-4 text-sm text-muted leading-relaxed">Music content streamed through Strumm is provided by YouTube and is subject to YouTube&apos;s Terms of Service. Strumm does not host, store, or distribute copyrighted audio files. We act as a metadata aggregator and streaming interface.</p>
        <p className="text-sm text-muted leading-relaxed">Report alleged copyright infringements via our <Link href="/dmca" className="text-primary hover:underline">DMCA Policy</Link>.</p>
      </>
    ),
  },
  {
    title: "Content Removal",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">Users retain ownership of the playlists, notes, and memories they create on the platform. We reserve the right to remove content that violates these terms or applicable law. For content removal requests, see our <Link href="/content-removal" className="text-primary hover:underline">Content Removal Policy</Link>.</p>
    ),
  },
  {
    title: "Disclaimer of Warranties",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE.&rdquo; WE MAKE NO WARRANTIES, EXPRESS OR IMPLIED, REGARDING THE AVAILABILITY, RELIABILITY, OR ACCURACY OF THE SERVICE. MUSIC STREAMING QUALITY DEPENDS ON YOUR INTERNET CONNECTION AND THIRD-PARTY SERVICES (YOUTUBE).</p>
    ),
  },
  {
    title: "Limitation of Liability",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">TO THE MAXIMUM EXTENT PERMITTED BY LAW, STRUMM SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE SERVICE.</p>
    ),
  },
  {
    title: "Termination",
    content: (
      <>
        <p className="mb-4 text-sm text-muted leading-relaxed">You may delete your account at any time via Profile → Account Control. This will permanently remove your account, playlists, listening history, liked songs, social connections, and player state from our servers.</p>
        <p className="text-sm text-muted leading-relaxed">We reserve the right to suspend or terminate accounts that violate these terms.</p>
      </>
    ),
  },
  {
    title: "Governing Law",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">These terms shall be governed by the laws of the jurisdiction in which the service operator is established. Any disputes shall be resolved through binding arbitration or small claims court.</p>
    ),
  },
  {
    title: "Contact",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">For questions about these terms, contact <a href="mailto:legal@strumm.me" className="text-primary hover:underline">legal@strumm.me</a>.</p>
    ),
  },
];

export default function TermsPage() {
  return (
    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <div className="mb-10">
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight">Terms of Service</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted">
          <span>Effective: July 1, 2026</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>Last updated: July 3, 2026</span>
        </div>
      </div>

      <div className="space-y-10">
        {sections.map((section, i) => (
          <section key={i} className="space-y-3">
            <h2 className="font-editorial text-xl text-text font-bold">{section.title}</h2>
            {section.content}
          </section>
        ))}
      </div>

      <div className="mt-16 pt-8 border-t border-border/40">
        <Link href="/privacy" className="text-sm text-primary hover:underline">Privacy Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/cookies" className="text-sm text-primary hover:underline">Cookie Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/dmca" className="text-sm text-primary hover:underline">DMCA Policy</Link>
      </div>
    </div>
  );
}
