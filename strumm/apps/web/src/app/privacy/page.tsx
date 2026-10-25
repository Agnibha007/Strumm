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
          <li><strong className="text-text">MongoDB (Primary Database):</strong> User accounts, playlists, listening history, sessions, and social data are stored in MongoDB. We retain listening history while your account is active to provide Strumm Replay and Sound DNA. Account deletion removes associated application records and access to owned uploaded media via Profile → Account Control. Older versions of uploaded objects may remain in the versioned object-storage bucket until its provider-side version-retention/lifecycle policy purges them.</li>
          <li><strong className="text-text">Local Storage (Browser):</strong> Your player queue, volume, theme preference, and auth token are cached in your browser&apos;s localStorage for offline resilience and faster load times.</li>
          <li><strong className="text-text">Cookies:</strong> We use httpOnly, Secure authentication cookies for access and refresh tokens. The access token is configured for a one-hour lifetime; the refresh session uses a sliding seven-day lifetime. Strumm does not set advertising cookies itself. Sentry diagnostics may transmit technical error/performance data and sampled session replay when configured; YouTube embeds may use their own cookies and browser storage.</li>
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
          <li><strong className="text-text">Groq (AI):</strong> When Flow or Explore Chat uses the Groq API, Strumm sends the current prompt and up to 10 recent chat messages, up to 15 liked songs, up to 15 recent plays, up to 30 playlist names with request-scoped aliases, and candidate track titles/artists. This context can reveal music preferences, and text you choose to enter may contain personal information. Stable Strumm user IDs, playlist database IDs, and account email are not intentionally included in the AI prompt. Avoid entering sensitive personal information into music-curation prompts. Groq is a third-party processor and its privacy policy applies. <Link href="https://groq.com/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Groq Privacy Policy</Link></li>
          <li><strong className="text-text">LRCLIB:</strong> Public API used for fetching lyrics. Strumm sends song lookup metadata such as title and artist.</li>
          <li><strong className="text-text">Sentry (Diagnostics):</strong> When the Sentry DSN is configured, Strumm uses Sentry for application error reports and performance tracing. The browser SDK also enables session replay: 10% session sampling and 100% sampling for sessions with recorded errors. Replay is configured to mask all text and input values and block media elements. Diagnostic data may include timestamps, route/technical metadata, stack traces, and a masked representation of interface activity. Server-side local-variable capture is disabled. <Link href="https://sentry.io/privacy/" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Sentry Privacy Policy</Link></li>
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
          <li><strong className="text-text">Deletion:</strong> Delete your entire account (including all associated data) from Profile → Account Control.</li>
          <li><strong className="text-text">Portability:</strong> Use Settings → Export Data → Download My Data to download a CSV export containing your profile, playlists, liked songs, listening history, and song memories. Exported history is not intentionally capped by the application.</li>
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
          <li>JWT access tokens (one-hour expiry) and refresh sessions (sliding seven-day expiry) are used for session management.</li>
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
