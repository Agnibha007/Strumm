import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";
import JsonLd from "web/components/JsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "About",
  description: "About Strumm — free music discovery with AI-assisted curation, playlists, podcasts, and listening analytics.",
  openGraph: {
    title: "About | Strumm",
    description: "Learn about Strumm — a free-to-use music app with AI-assisted curation, social features, and listening analytics.",
    url: "/about",
  },
  alternates: {
    canonical: `${appUrl}/about`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function AboutPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "About", href: "/about" },
      ]} />

      {/* AboutPage structured data */}
      <JsonLd
        schema={{
          "@context": "https://schema.org",
          "@type": "AboutPage",
          "@id": `${appUrl}/about#about`,
          name: "About Strumm",
          description:
            "About Strumm — free music discovery with AI-assisted curation, playlists, podcasts, and listening analytics.",
          url: `${appUrl}/about`,
          isPartOf: { "@id": `${appUrl}#website` },
          mainEntity: {
            "@type": "Organization",
            name: "Strumm",
            description:
              "A free-to-use music discovery app with AI-assisted curation, playlists, podcasts, and listening analytics.",
            foundingDate: "2024",
            email: "hello@strumm.me",
            url: appUrl,
          },
        }}
      />

    <article className="max-w-4xl py-8 sm:py-12 px-4 md:px-0 soft-enter">
      <header className="reform-panel p-6 sm:p-8 mb-8">
        <span className="reform-chip mb-3">About</span>
        <h1 className="reform-heading-xl text-text mb-4">Where your <span className="text-primary">music</span> lives.</h1>
        <p className="text-sm sm:text-base text-muted font-medium max-w-2xl">A bold, expressive home for discovery, playlists, podcasts, and listening identity.</p>
      </header>
      <section className="space-y-6 text-sm text-muted leading-relaxed">
        <p>Strumm is a premium, handcrafted music ecosystem built for music enthusiasts who value design, privacy, and discovery. It&apos;s not just a music player — it&apos;s a place where your music lives.</p>
        <p>Strumm does not sell listening data or insert its own advertising placements. Listening history is stored to power features such as Replay and recommendations. Sentry provides application diagnostics, including sampled masked session replay, when configured; YouTube embeds may process playback activity and serve their own ads under Google&apos;s policies.</p>
        <p>Key technologies powering Strumm include a Python/FastAPI backend with MongoDB, a Next.js React frontend with dynamic theming, AI-powered recommendations via Groq, and seamless YouTube streaming integration.</p>
      </section>
      <section aria-label="Platform details">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-8">
          {[{ label: "Pricing", value: "Free to use" }, { label: "Strumm ads", value: "None" }, { label: "Playback", value: "YouTube" }, { label: "Offline music", value: "Not available" }, { label: "License", value: "MIT" }, { label: "Diagnostics", value: "Sentry" }].map((stat) => (
            <figure key={stat.label} className="bg-surface/40 border border-border/60 rounded-xl p-4 text-center m-0">
              <div className="text-lg font-editorial font-bold text-text">{stat.value}</div>
              <figcaption className="text-[10px] text-muted uppercase tracking-wider mt-1">{stat.label}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </article>
    </>
  );
}
