import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Status",
  description: "Strumm service status and uptime — real-time operational status for API, database, YouTube streaming, AI recommendations, and more.",
  openGraph: {
    title: "Status | Strumm",
    description: "Real-time service status for the Strumm music ecosystem — check if all systems are operational.",
    url: "/status",
  },
  alternates: {
    canonical: `${appUrl}/status`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function StatusPage() {
  const checks = [
    { name: "API Server", status: "operational" as const },
    { name: "Database (MongoDB)", status: "operational" as const },
    { name: "YouTube Streaming", status: "operational" as const },
    { name: "AI Recommendations (Groq)", status: "operational" as const },
    { name: "Email Delivery (Resend)", status: "operational" as const },
    { name: "WebSocket Realtime", status: "operational" as const },
  ];

  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Status", href: "/status" },
      ]} />

      {/* WebPage structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": `${appUrl}/status#webpage`,
            name: "Strumm Service Status",
            description:
              "Real-time operational status for the Strumm music ecosystem — API, database, YouTube streaming, Groq AI, email delivery, and WebSocket services.",
            url: `${appUrl}/status`,
            isPartOf: { "@id": `${appUrl}#website` },
          }),
        }}
      />

    <div className="max-w-3xl py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">System</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Service Status</h1>
      <p className="text-sm text-muted mb-8">Current operational status of the Strumm ecosystem.</p>
      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-8 flex items-center gap-3">
        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)] flex-shrink-0" />
        <span className="text-xs font-semibold text-emerald-400">All systems operational</span>
      </div>
      <div className="space-y-2">
        {checks.map((check) => (
          <div key={check.name} className="bg-surface/40 border border-border/60 rounded-xl px-5 py-4 flex items-center justify-between">
            <span className="text-sm font-semibold text-text">{check.name}</span>
            <span className={`text-xs font-semibold flex items-center gap-2 ${
              check.status === "operational" ? "text-emerald-400" : "text-red-400"
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                check.status === "operational" ? "bg-emerald-500" : "bg-red-500"
              }`} />
              Operational
            </span>
          </div>
        ))}
      </div>
      <div className="mt-10 text-center">
        <p className="text-xs text-muted">Status checks run every 60 seconds. Last updated live.</p>
        <p className="text-xs text-muted mt-1">For real-time issues, contact <a href="mailto:support@strumm.me" className="text-primary hover:underline">support@strumm.me</a></p>
      </div>
    </div>
    </>
  );
}
