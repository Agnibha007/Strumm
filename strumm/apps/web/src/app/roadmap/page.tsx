import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "Strumm product roadmap and upcoming features.",
  openGraph: {
    title: "Roadmap | Strumm",
    description: "See what's coming next to Strumm.",
  },
};

const items = [
  { status: "in-progress" as const, title: "Mobile Native App", desc: "React Native companion for iOS and Android." },
  { status: "in-progress" as const, title: "Advanced Playlist Analytics", desc: "Deep insights into your playlist engagement and listener demographics." },
  { status: "planned" as const, title: "Offline Mode", desc: "Download songs for offline playback with smart storage management." },
  { status: "planned" as const, title: "Music Discovery Graphs", desc: "Visual exploration of artist connections and genre relationships." },
  { status: "planned" as const, title: "Shared Collaborative Playlists", desc: "Real-time collaborative playlist editing with Circle members." },
  { status: "planned" as const, title: "Advanced Audio Equalizer", desc: "System-wide 10-band EQ with presets and per-song profiles." },
  { status: "planned" as const, title: "Integration API", desc: "Public API for third-party integrations and automation." },
  { status: "planned" as const, title: "Smart Sleep Timer", desc: "AI-powered sleep timer that fades out based on your sleep patterns." },
];

export default function RoadmapPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Future</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Roadmap</h1>
      <p className="text-sm text-muted mb-8">What we are building next for Strumm.</p>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.title} className="bg-surface/40 border border-border/60 rounded-xl p-5 flex items-start gap-4">
            <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${
              item.status === "in-progress" ? "bg-primary shadow-[0_0_8px_var(--glow)]" : "bg-muted/40"
            }`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold text-text">{item.title}</h3>
                <span className={`text-[9px] uppercase tracking-wider font-semibold ${
                  item.status === "in-progress" ? "text-primary" : "text-muted"
                }`}>
                  {item.status === "in-progress" ? "In Progress" : "Planned"}
                </span>
              </div>
              <p className="text-xs text-muted mt-0.5">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
