import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Strumm release history and changelog — every release documented with version history, feature updates, and improvements.",
  openGraph: {
    title: "Changelog | Strumm",
    description: "Track every Strumm release — from v1.0.0 to v2.0.0, including AI curation, Sound DNA, podcasts, social features, and more.",
    url: "/changelog",
  },
  alternates: {
    canonical: `${appUrl}/changelog`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

const entries = [
  {
    date: "August 15, 2026",
    version: "2.3.0",
    changes: [
      "Repeat One now correctly replays the current song instead of advancing to the next track",
      "Shuffle and Repeat One are now mutually exclusive — enabling one turns the other off",
      "Stabilized Google OAuth and stop mid-session logouts after deploys via serialized token refresh",
      "Extended access tokens to 1 hour with hardened refresh against API cold starts",
      "Podcast episodes resume where you left off, with playback position persisted",
      "Engaged native fullscreen and unblocked fullscreen overlay controls",
      "Made listening stats sync reliable — stats dashboard routed through /proxy and aggregated from embedded history",
      "Decoded HTML entities in song titles and metadata at the API and player boundaries",
      "Service worker no longer intercepts RSC and API requests; purged stale shell cache",
      "Crossfade auto-advance no longer leaves the next song paused; transient YouTube PAUSED events during track swaps are ignored",
      "Micro-Animations toggle now actually disables animations",
      "Queue-advance and crossfade logic extracted into testable modules and wired into CI",
      "Removed the floating feedback button, keeping the feedback link in the sidebar",
      "Polished Strumm Flow curator UX",
    ],
  },
  {
    date: "July 12, 2026",
    version: "2.2.0",
    changes: [
      "3 new dynamic themes (Sage Forest, Midnight Amethyst, and Glacial Blue) added to the Theme Engine",
      "Consolidated ASGI middleware reducing base latency by 66%",
      "Implemented transparent caching for YTMusic API, podcast index catalog, and user authentication lookups",
      "Cached music recommendations locally on client for instant loads, with staggered fade/scale transitions on fresh updates",
      "Fixed GDPR user data export JSON serialization failure by recursively converting ObjectIds and datetimes",
    ],
  },
  {
    date: "July 4, 2026",
    version: "2.1.0",
    changes: [
      "Legal pages: Privacy Policy, Terms of Service, Cookie Policy, DMCA Policy, Content Removal Policy",
      "Trust pages: About, Contact, FAQ, Changelog, Roadmap, Status, Credits, Security, OSS Licenses, Report Bug, Feature Request",
      "404, 401, 403, 429, 503, Offline, and Maintenance error pages",
      "Password reset page with strength meter (4-bar validation)",
      "Password strength validation on backend (min 8 chars, upper + lower + number)",
      "Per-endpoint rate limiting (login: 5/min, signup: 3/min, forgot-password: 3/min, search: 30/min, general: 100/10s)",
      "Skip-to-content accessibility link and semantic <main> landmark",
      "Professional HTML email templates with dark mode support (6 email types)",
      "JSON-LD schemas: SoftwareApplication + enhanced Organization",
      "PWA: Offline fallback page with network-first service worker strategy",
      "Footer with legal/trust links across all pages",
    ],
  },
  {
    date: "July 3, 2026",
    version: "2.0.0",
    changes: [
      "Sound DNA live recalculation on every play event (removed 24h background refresh)",
      "Per-page SEO metadata for song, playlist, public profile, podcast show, and podcast episode pages",
      "Audio quality selector (Data Saver / Balanced / High)",
      "ConditionalFooter component with dynamic sidebar offset",
      "Fixed responsive fullscreen overlay layout (square artwork, better height constraints)",
      "Fixed player loading state not cleared when player already existed",
      "Resolved 99 lint issues across next.js app",
      "Removed duplicate function calls in backend API",
      "INFRASTRUCTURE.md — comprehensive deployment and operations documentation",
    ],
  },
  {
    date: "June 15, 2026",
    version: "1.5.0",
    changes: [
      "Podcast support with RSS feed integration",
      "Social Circle features with friend requests",
      "Collaborative listening Rooms",
      "Blend playlist generation",
      "Song Memories with reactions",
    ],
  },
  {
    date: "May 20, 2026",
    version: "1.3.0",
    changes: [
      "Strumm Replay with Sound DNA analysis",
      "AI-powered Discovery Mix via Groq",
      "Strumm Flow AI playlist curator",
      "8 dynamic themes (Obsidian, Black Cherry, Ocean Drive, Vinyl Classic, Monochrome, Aurora, Sunset Blvd, Rose Garden, Cyberpunk)",
      "Fullscreen player overlay with synced lyrics",
    ],
  },
  {
    date: "April 5, 2026",
    version: "1.1.0",
    changes: [
      "Google OAuth integration",
      "Real-time listening activity feed",
      "PWA support with service worker caching",
      "Synced lyrics via LRCLIB",
      "Playlist import from YouTube",
    ],
  },
  {
    date: "March 1, 2026",
    version: "1.0.0",
    changes: [
      "Initial public release",
      "Email/password authentication with JWT sessions",
      "YouTube music streaming via iframe API",
      "Basic playlist management",
      "MongoDB database backend",
      "Next.js frontend with dark theme engine",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Changelog", href: "/changelog" },
      ]} />

      {/* Article structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            "@id": `${appUrl}/changelog#article`,
            name: "Strumm Changelog",
            headline: "Strumm Release History — Every Version Documented",
            description:
              "Complete release history and changelog for Strumm music ecosystem, from v1.0.0 through v2.0.0, including AI features, podcast support, social features, and more.",
            url: `${appUrl}/changelog`,
            dateModified: "2026-08-15",
            datePublished: "2026-03-01",
            author: {
              "@type": "Organization",
              name: "Strumm",
              url: appUrl,
            },
            publisher: {
              "@type": "Organization",
              name: "Strumm",
              url: appUrl,
            },
            isPartOf: { "@id": `${appUrl}#website` },
          }),
        }}
      />

    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Updates</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Changelog</h1>
      <p className="text-sm text-muted mb-8">Every release of Strumm, documented.</p>
      <div className="space-y-6">
        {entries.map((entry) => (
          <div key={entry.version} className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-editorial text-lg font-bold text-text">v{entry.version}</h2>
              <span className="text-xs text-muted font-mono">{entry.date}</span>
            </div>
            <ul className="space-y-1.5">
              {entry.changes.map((change, i) => (
                <li key={i} className="text-xs text-muted flex items-start gap-2">
                  <span className="text-primary mt-1 select-none">·</span>
                  {change}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
    </>
  );
}
