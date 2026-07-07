import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

export const metadata: Metadata = {
  title: "Security",
  description: "Strumm security practices and vulnerability disclosure.",
  openGraph: {
    title: "Security | Strumm",
    description: "How Strumm protects your data and how to report vulnerabilities.",
  },
};

const practices = [
  { title: "Password Hashing", desc: "All passwords are hashed using bcrypt via passlib before storage. Plaintext passwords are never stored or logged." },
  { title: "JWT Authentication", desc: "Access tokens (15-minute expiry, auto-refreshed) and refresh tokens (30-day expiry) are used for session management. Tokens are stored in httpOnly, Secure, SameSite=None cookies." },
  { title: "HTTPS Everywhere", desc: "All API and web traffic is served over TLS/HTTPS. HTTP requests are redirected." },
  { title: "Content Security Policy", desc: "CSP headers restrict script sources to trusted origins (self, YouTube, Cloudflare). Inline scripts are limited." },
  { title: "Rate Limiting", desc: "Authentication endpoints (login, signup, password reset) have strict per-IP rate limits. General API has a 100 requests per 10 seconds limit per client." },
  { title: "CORS Configuration", desc: "Cross-Origin Resource Sharing is strictly configured to allow only trusted origins (strumm.me, localhost)." },
  { title: "Input Sanitization", desc: "All user inputs are sanitized and validated. YouTube video IDs are validated against a strict pattern. Text fields have length limits." },
  { title: "Security Headers", desc: "X-Frame-Options (DENY), X-Content-Type-Options (nosniff), Referrer-Policy (strict-origin-when-cross-origin), and X-XSS-Protection are set on all responses." },
];

export default function SecurityPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Security", href: "/security" },
      ]} />
    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Trust</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Security</h1>
      <p className="text-sm text-muted mb-8">How Strumm protects your data and our security practices.</p>
      <div className="space-y-8">
        <div className="grid grid-cols-1 gap-4">
          {practices.map((p) => (
            <div key={p.title} className="bg-surface/40 border border-border/60 rounded-xl p-5 space-y-1.5">
              <h3 className="text-sm font-bold text-text">{p.title}</h3>
              <p className="text-xs text-muted leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>
        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Reporting a Vulnerability</h2>
          <p className="text-sm text-muted leading-relaxed">If you discover a security vulnerability in Strumm, please report it responsibly. Do NOT create a public GitHub issue. Instead, send details to <a href="mailto:security@strumm.me" className="text-primary hover:underline">security@strumm.me</a>.</p>
          <p className="text-sm text-muted leading-relaxed">We aim to acknowledge reports within 24 hours and release a fix within 7 days for critical vulnerabilities. We believe in responsible disclosure and will credit researchers who report valid issues.</p>
        </section>
        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Dependencies</h2>
          <p className="text-sm text-muted leading-relaxed">We regularly update our dependencies to patch known vulnerabilities. The project uses automated dependency scanning via GitHub Dependabot. Key security-sensitive packages include: PyJWT, cryptography, passlib, bcrypt, and httpx.</p>
        </section>
      </div>
    </div>
    </>
  );
}
