import type { Metadata } from "next";
import PlaylistDetailClient from "./PlaylistDetailClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;

  try {
    const res = await fetch(`${BACKEND_URL}/playlists/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) {
      const playlist = json.data;
      const name = playlist.name || "Playlist";
      const songCount = playlist.songs?.length || 0;

      return {
        title: `${name} | Strumm`,
        description: `Listen to "${name}" — a curated playlist with ${songCount} tracks on Strumm.`,
        openGraph: {
          title: `${name} | Strumm Playlist`,
          description: `Listen to "${name}" — ${songCount} tracks curated on Strumm.`,
          url: `/playlist/${id}`,
          type: "music.playlist",
        },
        twitter: {
          card: "summary_large_image",
          title: `${name} | Strumm`,
          description: `Listen to "${name}" — ${songCount} tracks curated on Strumm.`,
        },
      };
    }
  } catch {
    // Backend unreachable — use generic metadata
  }

  return {
    title: `Playlist | Strumm`,
    description: "Discover curated playlists on Strumm — your premium music ecosystem.",
  };
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PlaylistDetailClient params={params} />;
}
