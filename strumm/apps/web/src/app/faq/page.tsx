import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Frequently asked questions about Strumm.",
  openGraph: {
    title: "FAQ | Strumm",
    description: "Find answers to common questions about Strumm.",
  },
};

const faqs = [
  {
    q: "What is Strumm?",
    a: "Strumm is a premium, handcrafted music ecosystem. It combines a powerful music player with YouTube streaming, AI-powered recommendations, podcast support, social features, and deep listening analytics — all in a beautifully designed, ad-free environment.",
  },
  {
    q: "Is Strumm free?",
    a: "Yes, Strumm is currently free to use. There are no subscription fees, no advertisements, and no tracking. Your listening data stays yours.",
  },
  {
    q: "How does music playback work?",
    a: "Strumm streams music through YouTube's iframe API. When you search for and play a song, Strumm resolves the YouTube video ID and plays it through the embedded YouTube player. No audio files are hosted or stored on our servers.",
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
    a: "Go to Profile → Account Control → Delete Account. Type 'DELETE' to confirm. This permanently removes your account, playlists, history, likes, and all associated data.",
  },
  {
    q: "What data does Strumm collect?",
    a: "Strumm collects your email, username, listening history (songs played, duration, timestamps), playlists, and player state for core functionality. We do not sell your data or serve ads. See our Privacy Policy for full details.",
  },
  {
    q: "Does Strumm work offline?",
    a: "The Strumm PWA caches the app shell for faster loading, but music streaming requires an internet connection since playback relies on YouTube's streaming infrastructure.",
  },
  {
    q: "How do I report a bug?",
    a: "You can report bugs by contacting us at support@strumm.me or by filing an issue on our GitHub repository.",
  },
];

export default function FAQPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Support</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Frequently Asked Questions</h1>
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
      <div className="mt-10 text-center">
        <p className="text-sm text-muted">Still have questions? <a href="/contact" className="text-primary hover:underline">Contact us</a></p>
      </div>
    </div>
  );
}
