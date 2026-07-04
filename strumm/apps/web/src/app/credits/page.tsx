import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Credits",
  description: "Strumm credits and acknowledgments.",
  openGraph: {
    title: "Credits | Strumm",
    description: "The people and technologies behind Strumm.",
  },
};

export default function CreditsPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Acknowledgments</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-8">Credits</h1>
      <div className="space-y-8">
        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Technology</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Next.js", url: "https://nextjs.org" },
              { name: "React", url: "https://react.dev" },
              { name: "FastAPI", url: "https://fastapi.tiangolo.com" },
              { name: "MongoDB / Motor", url: "https://www.mongodb.com" },
              { name: "Tailwind CSS", url: "https://tailwindcss.com" },
              { name: "Framer Motion", url: "https://www.framer.com/motion" },
              { name: "Zustand", url: "https://github.com/pmndrs/zustand" },
              { name: "NextAuth.js", url: "https://next-auth.js.org" },
              { name: "Lucide Icons", url: "https://lucide.dev" },
              { name: "ytmusicapi", url: "https://github.com/sigma67/ytmusicapi" },
              { name: "Groq AI", url: "https://groq.com" },
              { name: "Resend", url: "https://resend.com" },
            ].map((tech) => (
              <a key={tech.name} href={tech.url} target="_blank" rel="noopener noreferrer" className="bg-surface/40 border border-border/60 rounded-xl px-4 py-3 text-sm font-semibold text-text hover:border-primary/30 transition flex items-center justify-between">
                {tech.name}
                <span className="text-[9px] text-muted uppercase">↗</span>
              </a>
            ))}
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Open Source</h2>
          <p className="text-sm text-muted leading-relaxed">Strumm is built on the shoulders of open source software. We are grateful to every maintainer and contributor who makes projects like Next.js, Python, Tailwind CSS, and MongoDB available freely. View our full <Link href="/licenses" className="text-primary hover:underline">Open Source Licenses</Link> page.</p>
        </section>
        <section className="space-y-3">
          <h2 className="font-editorial text-xl text-text font-bold">Design & Vision</h2>
          <p className="text-sm text-muted leading-relaxed">Strumm is designed with a focus on editorial aesthetics, dark-first interfaces, and music-centric typography. Special thanks to the open source design community for inspiration and tools.</p>
        </section>
      </div>
    </div>
  );
}
