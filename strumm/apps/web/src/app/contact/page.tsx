import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the Strumm team.",
  openGraph: {
    title: "Contact | Strumm",
    description: "Reach out for support, feedback, or inquiries.",
  },
};

export default function ContactPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Contact</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Get in touch</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {[
          { label: "General Inquiries", email: "hello@strumm.me", desc: "For general questions, feedback, or partnership opportunities." },
          { label: "Privacy & Data", email: "privacy@strumm.me", desc: "For privacy-related inquiries or data deletion requests." },
          { label: "DMCA / Copyright", email: "dmca@strumm.me", desc: "For DMCA takedown notices and copyright concerns." },
          { label: "Content Removal", email: "abuse@strumm.me", desc: "To report inappropriate content or policy violations." },
          { label: "Security", email: "security@strumm.me", desc: "To report security vulnerabilities or concerns." },
          { label: "Support", email: "support@strumm.me", desc: "For technical support and account issues." },
        ].map((item) => (
          <div key={item.email} className="bg-surface/40 border border-border/60 rounded-xl p-5 space-y-2 hover:border-primary/30 transition">
            <h3 className="text-sm font-bold text-text">{item.label}</h3>
            <p className="text-xs text-muted leading-relaxed">{item.desc}</p>
            <a href={`mailto:${item.email}`} className="text-xs text-primary hover:underline font-semibold">{item.email}</a>
          </div>
        ))}
      </div>
    </div>
  );
}
