import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description: "Strumm Cookie Policy — how we use cookies and local storage.",
  openGraph: {
    title: "Cookie Policy | Strumm",
    description: "Learn about the cookies and local storage used by Strumm.",
  },
};

export default function CookiesPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <div className="mb-10">
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight">Cookie Policy</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted">
          <span>Effective: July 1, 2026</span>
          <span className="w-1 h-1 rounded-full bg-border" />
          <span>Last updated: July 3, 2026</span>
        </div>
      </div>

      <div className="space-y-10">
        <p className="text-sm text-muted leading-relaxed">
          This Cookie Policy explains how Strumm uses cookies, local storage, and similar technologies to provide and improve our service.
        </p>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">What Are Cookies?</h2>
          <p className="text-sm text-muted leading-relaxed">Cookies are small text files stored on your device by your web browser. Strumm uses only strictly necessary cookies for authentication and security purposes. We do not use tracking cookies, advertising cookies, or third-party analytics cookies.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Cookies We Use</h2>
          <div className="space-y-4">
            <div className="bg-surface/40 border border-border/60 rounded-xl p-5">
              <h3 className="text-sm font-bold text-text mb-1">access_token</h3>
              <p className="text-xs text-muted leading-relaxed"><strong>Purpose:</strong> JWT access token for authenticating API requests. <strong>Type:</strong> httpOnly, Secure, SameSite=None. <strong>Duration:</strong> 15 minutes (auto-refreshed). <strong>Essential:</strong> Yes — the service cannot function without it.</p>
            </div>
            <div className="bg-surface/40 border border-border/60 rounded-xl p-5">
              <h3 className="text-sm font-bold text-text mb-1">refresh_token</h3>
              <p className="text-xs text-muted leading-relaxed"><strong>Purpose:</strong> JWT refresh token for obtaining new access tokens without re-login. <strong>Type:</strong> httpOnly, Secure, SameSite=None. <strong>Duration:</strong> 30 days. <strong>Essential:</strong> Yes.</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Local Storage</h2>
          <p className="text-sm text-muted leading-relaxed mb-4">In addition to cookies, Strumm uses browser localStorage for:</p>
          <div className="space-y-4">
            <div className="bg-surface/40 border border-border/60 rounded-xl p-5">
              <h3 className="text-sm font-bold text-text mb-1">strumm-auth-cache</h3>
              <p className="text-xs text-muted leading-relaxed">Caches your user profile and JWT token for faster app initialization and offline resilience.</p>
            </div>
            <div className="bg-surface/40 border border-border/60 rounded-xl p-5">
              <h3 className="text-sm font-bold text-text mb-1">strumm-player-cache</h3>
              <p className="text-xs text-muted leading-relaxed">Stores your player queue, volume, shuffle/repeat state, and audio quality preference so playback state persists across sessions.</p>
            </div>
            <div className="bg-surface/40 border border-border/60 rounded-xl p-5">
              <h3 className="text-sm font-bold text-text mb-1">strumm-theme-cache</h3>
              <p className="text-xs text-muted leading-relaxed">Caches your selected theme and extracted accent color to prevent flash of unstyled content on page load.</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Third-Party Storage</h2>
          <p className="text-sm text-muted leading-relaxed mb-4">When you stream music via YouTube&apos;s iframe API, YouTube may set its own cookies and local storage in accordance with <Link href="https://policies.google.com/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">Google&apos;s Privacy Policy</Link>. We have no control over these technologies.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Your Choices</h2>
          <ul className="list-disc pl-6 space-y-2 text-sm text-muted leading-relaxed">
            <li>You can clear cookies and localStorage at any time via your browser settings. Note that this will sign you out and reset your player preferences.</li>
            <li>Most browsers allow you to block cookies, but this will break authentication and make Strumm unusable.</li>
            <li>You can use browser&apos;s &ldquo;Clear Site Data&rdquo; or equivalent feature to remove all Strumm-stored data.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Updates</h2>
          <p className="text-sm text-muted leading-relaxed">We may update this Cookie Policy as our service evolves. The latest version will always be posted here with an updated &ldquo;Last updated&rdquo; date.</p>
        </section>

        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Contact</h2>
          <p className="text-sm text-muted leading-relaxed">Questions about this policy? Contact us at <a href="mailto:privacy@strumm.me" className="text-primary hover:underline">privacy@strumm.me</a>.</p>
        </section>
      </div>

      <div className="mt-16 pt-8 border-t border-border/40">
        <Link href="/privacy" className="text-sm text-primary hover:underline">Privacy Policy</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/terms" className="text-sm text-primary hover:underline">Terms of Service</Link>
        <span className="mx-3 text-muted">·</span>
        <Link href="/dmca" className="text-sm text-primary hover:underline">DMCA Policy</Link>
      </div>
    </div>
  );
}
