import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Open Source Licenses",
  description: "Open source licenses used by Strumm.",
};

const licenses = [
  { name: "Next.js", license: "MIT", author: "Vercel" },
  { name: "React", license: "MIT", author: "Meta" },
  { name: "Framer Motion", license: "MIT", author: "Framer" },
  { name: "Zustand", license: "MIT", author: "Paul Henschel" },
  { name: "Tailwind CSS", license: "MIT", author: "Tailwind Labs" },
  { name: "Lucide Icons", license: "ISC", author: "Lucide Contributors" },
  { name: "NextAuth.js", license: "ISC", author: "NextAuth.js" },
  { name: "FastAPI", license: "MIT", author: "Sebastián Ramírez" },
  { name: "Uvicorn", license: "BSD-3-Clause", author: "Encode" },
  { name: "Motor", license: "Apache 2.0", author: "MongoDB" },
  { name: "Pydantic", license: "MIT", author: "Samuel Colvin" },
  { name: "httpx", license: "BSD-3-Clause", author: "Encode" },
  { name: "ytmusicapi", license: "MIT", author: "sigma67" },
  { name: "Pillow", license: "MIT-CMU", author: "Alex Clark" },
  { name: "python-jose", license: "MIT", author: "Michael Davis" },
  { name: "beautifulsoup4", license: "MIT", author: "Leonard Richardson" },
  { name: "feedparser", license: "BSD-2-Clause", author: "Kurt McKee" },
  { name: "Turborepo", license: "MIT", author: "Vercel" },
];

export default function LicensesPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Legal</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Open Source Licenses</h1>
      <p className="text-sm text-muted mb-8">Strumm is built on open source software. We thank these projects and their maintainers.</p>
      <div className="bg-surface/40 border border-border/60 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-0 text-xs font-semibold text-muted uppercase tracking-wider px-5 py-3 border-b border-border/40 bg-surface/20">
          <span>Package</span>
          <span className="px-4">License</span>
          <span>Author</span>
        </div>
        {licenses.map((l) => (
          <div key={l.name} className="grid grid-cols-[1fr_auto_auto] gap-0 text-sm px-5 py-3 border-b border-border/20 last:border-0">
            <span className="font-semibold text-text">{l.name}</span>
            <span className="text-muted px-4">{l.license}</span>
            <span className="text-muted text-right">{l.author}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
