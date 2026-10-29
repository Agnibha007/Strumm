import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Frequently asked questions about Strumm — free music discovery with AI-assisted curation, playlists, podcasts, and listening analytics.",
  openGraph: {
    title: "FAQ | Strumm",
    description: "Find answers to common questions about Strumm — how playback works, privacy, account features, and more.",
    url: "/faq",
  },
  alternates: {
    canonical: `${appUrl}/faq`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

const faqs = [
  {
    q: "What is Strumm?",
    a: "Strumm is a free-to-use music discovery app with YouTube-powered playback, AI-assisted recommendations, podcasts, social features, and listening analytics. Strumm does not insert its own ads, but embedded providers may serve ads.",
  },
  {
    q: "Is Strumm free?",
    a: "Yes, Strumm is currently free to use with no subscription fee. Strumm does not insert its own ad placements or sell listening data. We use Sentry for application error/performance diagnostics and sampled, masked session replay; YouTube embeds may also use provider cookies/storage or show provider-served ads. Details are in our Privacy Policy.",
  },
  {
    q: "How does music playback work?",
    a: "Strumm resolves track metadata and usually plays through YouTube's embedded player. A backend audio-streaming fallback may be used for supported background-playback or network cases. Offline song downloads are available only when a track source explicitly provides an authorized download URL. Strumm does not extract or convert YouTube streams into downloadable files; other YouTube-backed tracks require an internet connection.",
  },
  {
    q: "What is Strumm Replay?",
    a: "Strumm Replay is your personalized listening dashboard. It shows total listening minutes, top songs, top artists, music personality, Sound DNA (energy, discovery, nostalgia, variety, repeat rate), favorite listening time, and top genres. It's calculated live as you stream.",
  },
  {
    q: "What is Sound DNA?",
    a: "Sound DNA is a five-dimensional analysis of your listening patterns: Energy (high-energy vs. relaxed tracks), Discovery (how many new artists you explore), Nostalgia (preference for classic/retro content), Variety (how diverse your track selection is), and Repeat Rate (how often you replay favorites).",
  },
  {
    q: "How do I create a playlist?",
    a: "You can create playlists via the Playlists page or by using Strumm Flow — our AI-powered playlist curator. You can also import playlists from YouTube or other sources using the Import feature.",
  },
  {
    q: "Can I listen with friends?",
    a: "Yes! Strumm Circle lets you connect with friends, see what they're listening to (if they choose to share), create collaborative Blend playlists, and join shared listening Rooms.",
  },
  {
    q: "How do I sign up?",
    a: "You can sign up with your email address (verification code sent via email) or use Google OAuth. We use JWT tokens for authentication with bcrypt-hashed passwords.",
  },
  {
    q: "How do I delete my account?",
    a: "Go to Profile → Account Control → Delete Account and confirm the prompt. Strumm removes the account and associated application records, social references, sessions, and owned media from active app storage. If storage is unavailable or cleanup fails, the request reports failure so you can retry. The storage bucket is versioned, so older uploaded-object versions may remain until the storage provider's version-retention/lifecycle policy purges them; third-party provider records follow their own policies.",
  },
  {
    q: "What data does Strumm collect?",
    a: "Strumm stores account details, playlists, listening history, player state, and related social data for core functionality. It does not sell listening data or insert its own ads. Sentry receives limited diagnostics, including sampled session replay, when configured; YouTube processes activity associated with its embedded player. See the Privacy Policy.",
  },
  {
    q: "Does Strumm work offline?",
    a: "The Strumm PWA caches the app shell. Podcast episodes and eligible songs you download are stored on this device and can play offline. YouTube-backed tracks without an authorized download asset still require an internet connection.",
  },
  {
    q: "How do I report a bug?",
    a: "You can report bugs by contacting us at support@strumm.me or by filing an issue on our GitHub repository.",
  },
];

export default function FAQPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "FAQ", href: "/faq" },
      ]} />
      {/* FAQPage structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "@id": `${appUrl}/faq#faq`,
            name: "Strumm FAQ",
            description: "Frequently asked questions about Strumm music ecosystem.",
            mainEntity: faqs.map((faq) => ({
              "@type": "Question",
              name: faq.q,
              acceptedAnswer: {
                "@type": "Answer",
                text: faq.a,
              },
            })),
          }),
        }}
      />
      <section aria-label="Frequently asked questions" className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <header>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Support</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Frequently Asked Questions</h1>
      </header>
      <section aria-label="Questions and answers">
        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <details key={i} className="bg-surface/40 border border-border/60 rounded-xl overflow-hidden group">
              <summary className="px-5 py-4 cursor-pointer text-sm font-semibold text-text hover:text-primary transition flex items-center justify-between select-none">
                <span>{faq.q}</span>
                <span className="text-muted text-xs group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="px-5 pb-4 text-sm text-muted leading-relaxed border-t border-border/40 pt-3">
                {faq.a}
              </div>
            </details>
          ))}
        </div>
      </section>
      <footer className="mt-10 text-center">
        <p className="text-sm text-muted">Still have questions? <a href="/contact" className="text-primary hover:underline">Contact us</a></p>
      </footer>
    </section>
    </>
  );
}
