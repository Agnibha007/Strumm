import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "About",
  description: "About Strumm — the premium, handcrafted music ecosystem with AI playlists, podcast support, and listening analytics.",
  openGraph: {
    title: "About | Strumm",
    description: "Learn about Strumm — a private, ad-free music ecosystem with AI curation and smart analytics.",
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

export default function AboutPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "About", href: "/about" },
      ]} />

      {/* AboutPage structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "AboutPage",
            "@id": `${appUrl}/about#about`,
            name: "About Strumm",
            description:
              "About Strumm — a premium, handcrafted music ecosystem with AI playlists, podcast support, and listening analytics.",
            url: `${appUrl}/about`,
            isPartOf: { "@id": `${appUrl}#website` },
            mainEntity: {
              "@type": "Organization",
              name: "Strumm",
              description:
                "A premium music ecosystem with AI-powered recommendations, custom playlists, podcast support, and listening analytics.",
              foundingDate: "2024",
              email: "hello@strumm.me",
              url: appUrl,
            },
          }),
        }}
      />

    <article className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <header>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">About</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Where your music lives.</h1>
      </header>
      <section className="space-y-6 text-sm text-muted leading-relaxed">
        <p>Strumm is a premium, handcrafted music ecosystem built for music enthusiasts who value design, privacy, and discovery. It&apos;s not just a music player — it&apos;s a place where your music lives.</p>
        <p>Unlike mainstream streaming services, Strumm doesn&apos;t track you, sell your data, or serve advertisements. Your listening habits remain yours. Every feature is designed with the listener&apos;s experience first.</p>
        <p>Key technologies powering Strumm include a Python/FastAPI backend with MongoDB, a Next.js React frontend with dynamic theming, AI-powered recommendations via Groq, and seamless YouTube streaming integration.</p>
      </section>
      <section aria-label="Platform statistics">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-8">
          {[{ label: "Active Users", value: "Growing" }, { label: "Songs Streamed", value: "Millions" }, { label: "Uptime", value: "99.9%" }, { label: "Open Source", value: "Yes" }, { label: "Trackers", value: "Zero" }, { label: "Ads", value: "None" }].map((stat) => (
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
