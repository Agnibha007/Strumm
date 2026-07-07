import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the Strumm team for support, feedback, privacy concerns, or business inquiries.",
  openGraph: {
    title: "Contact | Strumm",
    description: "Reach out to the Strumm team for support, feedback, or inquiries.",
    url: "/contact",
  },
  alternates: {
    canonical: `${appUrl}/contact`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function ContactPage() {
  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Contact", href: "/contact" },
      ]} />
      {/* ContactPage structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "ContactPage",
            "@id": `${appUrl}/contact#contact`,
            name: "Contact Strumm",
            description: "Get in touch with the Strumm team for support, feedback, or inquiries.",
            url: `${appUrl}/contact`,
            mainEntity: {
              "@type": "Organization",
              name: "Strumm",
              email: "hello@strumm.me",
              contactPoint: [
                { "@type": "ContactPoint", contactType: "customer support", email: "support@strumm.me" },
                { "@type": "ContactPoint", contactType: "privacy", email: "privacy@strumm.me" },
                { "@type": "ContactPoint", contactType: "copyright", email: "dmca@strumm.me" },
                { "@type": "ContactPoint", contactType: "security", email: "security@strumm.me" },
              ],
            },
          }),
        }}
      />
      <article className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <header>
        <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Contact</span>
        <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Get in touch</h1>
      </header>
      <section aria-label="Contact information">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {[
            { label: "General Inquiries", email: "hello@strumm.me", desc: "For general questions, feedback, or partnership opportunities." },
            { label: "Privacy & Data", email: "privacy@strumm.me", desc: "For privacy-related inquiries or data deletion requests." },
            { label: "DMCA / Copyright", email: "dmca@strumm.me", desc: "For DMCA takedown notices and copyright concerns." },
            { label: "Content Removal", email: "abuse@strumm.me", desc: "To report inappropriate content or policy violations." },
            { label: "Security", email: "security@strumm.me", desc: "To report security vulnerabilities or concerns." },
            { label: "Support", email: "support@strumm.me", desc: "For technical support and account issues." },
          ].map((item) => (
            <address key={item.email} className="bg-surface/40 border border-border/60 rounded-xl p-5 space-y-2 hover:border-primary/30 transition not-italic">
              <h3 className="text-sm font-bold text-text">{item.label}</h3>
              <p className="text-xs text-muted leading-relaxed">{item.desc}</p>
              <a href={`mailto:${item.email}`} className="text-xs text-primary hover:underline font-semibold">{item.email}</a>
            </address>
          ))}
        </div>
      </section>
    </article>
    </>
  );
}
