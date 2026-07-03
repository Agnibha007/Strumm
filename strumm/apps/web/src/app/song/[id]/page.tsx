import type { Metadata } from "next";
import SongDetailClient from "./SongDetailClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;

  try {
    const res = await fetch(`${BACKEND_URL}/resolve/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) {
      const song = json.data;
      const title = song.title || "Unknown Track";
      const artist = song.artist || "Unknown Artist";
      const thumbnail = song.thumbnail;

      return {
        title: `${title} — ${artist} | Strumm`,
        description: `Listen to "${title}" by ${artist} on Strumm — your premium music ecosystem.`,
        openGraph: {
          title: `${title} — ${artist} | Strumm`,
          description: `Listen to "${title}" by ${artist} on Strumm.`,
          url: `/song/${id}`,
          images: thumbnail ? [{ url: thumbnail, width: 480, height: 360 }] : [],
          type: "music.song",
        },
        twitter: {
          card: "summary_large_image",
          title: `${title} — ${artist} | Strumm`,
          description: `Listen to "${title}" by ${artist} on Strumm.`,
          images: thumbnail ? [thumbnail] : [],
        },
      };
    }
  } catch {
    // Backend unreachable — use generic metadata
  }

  return {
    title: `Song | Strumm`,
    description: "Listen to music on Strumm — your premium music ecosystem.",
  };
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <SongDetailClient params={params} />;
}
