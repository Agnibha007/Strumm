import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Strumm release history and changelog.",
  openGraph: {
    title: "Changelog | Strumm",
    description: "What's new in Strumm.",
  },
};

const entries = [
  {
    date: "July 3, 2026",
    version: "2.0.0",
    changes: [
      "Sound DNA live recalculation on every play event (removed 24h background refresh)",
      "Per-page SEO metadata for song, playlist, public profile, podcast show, and podcast episode pages",
      "Privacy Policy, Terms of Service, Cookie Policy, DMCA, and Content Removal pages",
      "About, Contact, FAQ, Changelog, Status, and Credits pages added",
      "Footer navigation with legal and trust links across all pages",
      "Lyrics fix — removed hard database requirement, works for songs from search",
      "Sound DNA fix — uses real histories instead of simulated entries",
      "SEO canonical fix — removed global canonical that blocked Google indexing",
      "Sitemap hardening — fallback entries when backend is unreachable at build time",
      "Fullscreen player text cutoff fix — title/artist now wraps properly",
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
