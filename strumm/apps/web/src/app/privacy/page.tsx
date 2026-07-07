import { Metadata } from "next";
import Link from "next/link";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Strumm Privacy Policy — how we collect, use, and protect your personal data and listening history.",
  openGraph: {
    title: "Privacy Policy | Strumm",
    description: "How Strumm handles your personal data, listening history, and privacy rights.",
    url: "/privacy",
  },
  alternates: {
    canonical: `${appUrl}/privacy`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

const sections = [
  {
    title: "Information We Collect",
    content: (
      <>
        <p className="mb-4">When you create an account or use Strumm, we collect the following categories of information:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li><strong className="text-text">Account Information:</strong> Email address, username, display name, and avatar (if provided). If you sign up via Google OAuth, we receive your name, email, and profile picture from your Google account.</li>
          <li><strong className="text-text">Listening History:</strong> We record every song you play, including the title, artist, video ID, duration listened, and timestamp. This data powers your Strumm Replay, Sound DNA, personalized recommendations, and listening statistics.</li>
          <li><strong className="text-text">Playlists & Liked Songs:</strong> Your created playlists, liked songs, and any notes or tags you add to them.</li>
          <li><strong className="text-text">Player State:</strong> Your current queue, volume preferences, playback position, shuffle/repeat settings, and audio quality preference are stored to sync playback across sessions.</li>
          <li><strong className="text-text">Device & Session Data:</strong> When you log in, we store a session record containing your user agent string (browser/device info), refresh token hash, and login timestamp.</li>
          <li><strong className="text-text">Theme Preference:</strong> Your selected theme (Obsidian, Black Cherry, Ocean Drive, etc.) is stored locally and synced to your profile.</li>
          <li><strong className="text-text">Social Activity:</strong> If enabled, your currently playing song may be broadcast to your Circle (friends) in real time. Connection requests, follows, and room participation are stored.</li>
          <li><strong className="text-text">Communications:</strong> If you contact us, we retain the contents of your message and your email address for support purposes.</li>
        </ul>
      </>
    ),
  },
  {
    title: "How We Use Your Information",
    content: (
      <>
        <p className="mb-4">Your data is used solely to operate and improve Strumm:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li>To authenticate you and maintain your session (JWT access tokens + refresh tokens stored in httpOnly cookies and localStorage).</li>
          <li>To generate personalized features: Strumm Replay (listening statistics), Sound DNA (music personality analysis), Discovery Mix (AI-curated recommendations using Groq AI when available), and Flow (smart playlist curation).</li>
          <li>To sync your player state across devices.</li>
          <li>To send transactional emails via Resend or SMTP (verification codes, password reset links).</li>
          <li>To enable social features: Circle (friend connections), shared listening activity, collaborative rooms, and blend playlists.</li>
          <li>To resolve YouTube Music metadata for song playback via the YouTube Data API and ytmusicapi library.</li>
        </ul>
      </>
    ),
  },
  {
    title: "Data Storage & Retention",
    content: (
      <>
        <p className="mb-4">We use the following storage mechanisms:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li><strong className="text-text">MongoDB (Primary Database):</strong> All user accounts, playlists, listening history, sessions, and social data are stored in a MongoDB database. We retain your listening history indefinitely to provide Strumm Replay and Sound DNA. You can delete your entire history or your full account at any time via Profile → Account Control.</li>
          <li><strong className="text-text">Local Storage (Browser):</strong> Your player queue, volume, theme preference, and auth token are cached in your browser&apos;s localStorage for offline resilience and faster load times.</li>
          <li><strong className="text-text">Cookies:</strong> We use httpOnly, secure, SameSite=None cookies for JWT access tokens and refresh tokens. These are essential for authentication and cannot be disabled while using the service. We do not use third-party tracking cookies.</li>
          <li><strong className="text-text">Service Worker Cache:</strong> Our PWA service worker caches the app shell (static assets) for offline access. Media streams and API responses are explicitly excluded from caching.</li>
        </ul>
        <p className="text-sm text-muted leading-relaxed">Data is retained for as long as your account is active. You may request data deletion at any time (see &ldquo;Your Rights&rdquo; below).</p>
      </>
    ),
  },
  {
    title: "Third-Party Services",
    content: (
      <>
        <p className="mb-4">Strumm integrates with the following third-party services:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li><strong className="text-text">MongoDB Atlas:</strong> Our database provider. Data is stored in encrypted-at-rest MongoDB clusters. <Link href="https://www.mongodb.com/legal/privacy-policy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">MongoDB Privacy Policy</Link></li>
          <li><strong className="text-text">YouTube / Google:</strong> Music streaming and metadata resolution via the YouTube iframe API and YouTube Data API. Google&apos;s privacy policy applies to content loaded from YouTube. <Link href="https://policies.google.com/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Google Privacy Policy</Link></li>
          <li><strong className="text-text">Google OAuth:</strong> Optional social login. When used, Google shares your name, email, and profile picture with Strumm. <Link href="https://policies.google.com/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Google Privacy Policy</Link></li>
          <li><strong className="text-text">Resend:</strong> Transactional email delivery (verification codes, password resets). <Link href="https://resend.com/legal/privacy-policy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Resend Privacy Policy</Link></li>
          <li><strong className="text-text">Groq (AI):</strong> Optional AI-powered recommendations and music curation via the Groq API. Only anonymized song metadata (titles, genres) is sent; no personal identifiers are shared. <Link href="https://groq.com/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Groq Privacy Policy</Link></li>
          <li><strong className="text-text">LRCLIB:</strong> Public API used for fetching synced lyrics. No personal data is shared.</li>
        </ul>
      </>
    ),
  },
  {
    title: "Your Rights",
    content: (
      <>
        <p className="mb-4">You have the following rights regarding your data:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li><strong className="text-text">Access:</strong> View your profile, statistics, and listening history at any time via the app.</li>
          <li><strong className="text-text">Correction:</strong> Update your display name, username, and avatar in Settings.</li>
          <li><strong className="text-text">Deletion:</strong> Delete your entire account (including all associated data) from Profile → Account Control. You can also clear your listening history separately.</li>
          <li><strong className="text-text">Portability:</strong> Currently, data export is available upon request. Contact us at the email below.</li>
          <li><strong className="text-text">Withdraw Consent:</strong> Disable social listening activity sharing in Profile → Privacy Controls at any time.</li>
        </ul>
      </>
    ),
  },
  {
    title: "Children&apos;s Privacy",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">Strumm is not directed at children under the age of 13 (or the equivalent minimum age in your jurisdiction). We do not knowingly collect personal information from children. If you believe a child has provided us with personal data, please contact us immediately, and we will take steps to delete that information.</p>
    ),
  },
  {
    title: "International Data Transfers",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">Your data may be processed in countries where our hosting providers (Render, MongoDB Atlas, Hugging Face) maintain servers. By using Strumm, you consent to the transfer of your information to these countries, which may have different data protection laws than your country of residence.</p>
    ),
  },
  {
    title: "Security",
    content: (
      <>
        <p className="mb-4">We implement industry-standard security measures:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 text-sm text-muted leading-relaxed">
          <li>Passwords are hashed using bcrypt (via passlib) before storage. We never store plaintext passwords.</li>
          <li>JWT access tokens (15-minute default expiry) and refresh tokens (30-day expiry) are used for session management.</li>
          <li>All API traffic is served over HTTPS.</li>
          <li>Cookies are httpOnly, Secure, and SameSite=None.</li>
          <li>Rate limiting is enforced on authentication and API endpoints.</li>
          <li>Content Security Policy (CSP) headers restrict script and resource loading.</li>
        </ul>
      </>
    ),
  },
  {
    title: "Changes to This Policy",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">We may update this Privacy Policy from time to time. We will notify you of material changes by posting the updated policy on this page and updating the &ldquo;Last Updated&rdquo; date. Continued use of Strumm after changes constitutes acceptance of the revised policy.</p>
    ),
  },
  {
    title: "Contact",
    content: (
      <p className="text-sm text-muted leading-relaxed mb-4">For privacy-related inquiries, data requests, or concerns, please contact us at <a href="mailto:privacy@strumm.me" className="text-primary hover:underline">privacy@strumm.me</a>.</p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Privacy Policy", href: "/privacy" },
      ]} />
      {/* PrivacyPolicy structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "PrivacyPolicy",
            "@id": `${appUrl}/privacy#policy`,
            name: "Strumm Privacy Policy",
            description:
              "How Strumm collects, uses, and protects your personal data and listening history.",
            publisher: {
              "@type": "Organization",
              name: "Strumm",
              url: appUrl,
            },
            url: `${appUrl}/privacy`,
            isPartOf: { "@id": `${appUrl}#website` },
          }),
        }}
      />
      <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <div className="mb-10">
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight">Privacy Policy</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted">
          <span>Effective: July 1, 2026</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>Last updated: July 3, 2026</span>
        </div>
      </div>

      <div className="prose prose-invert max-w-none space-y-10">
        <p className="text-sm text-muted leading-relaxed">
          This Privacy Policy explains how Strumm (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) collects, uses, stores, and protects your personal information when you use the Strumm music ecosystem. By creating an account or using the service, you agree to the practices described in this policy.
        </p>

        {sections.map((section, i) => (
          <section key={i} className="space-y-3">
            <h2 className="font-editorial text-xl text-text font-bold">{section.title}</h2>
            {section.content}
          </section>
        ))}
      </div>

      <div className="mt-16 pt-8 border-t border-border/40">
        <Link href="/terms" className="text-sm text-primary hover:underline">View Terms of Service</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/cookies" className="text-sm text-primary hover:underline">Cookie Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/dmca" className="text-sm text-primary hover:underline">DMCA Policy</Link>
      </div>
    </div>
    </>
  );
}
