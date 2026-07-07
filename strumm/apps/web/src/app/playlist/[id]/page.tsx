import type { Metadata } from "next";
import PlaylistDetailClient from "./PlaylistDetailClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const canonicalUrl = `${baseUrl}/playlist/${id}`;

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
        alternates: { canonical: canonicalUrl },
        openGraph: {
          title: `${name} | Strumm Playlist`,
          description: `Listen to "${name}" — ${songCount} tracks curated on Strumm.`,
          url: canonicalUrl,
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
    alternates: { canonical: canonicalUrl },
  };
}

async function fetchPlaylistData(id: string) {
  try {
    const res = await fetch(`${BACKEND_URL}/playlists/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) return json.data;
  } catch {
    // Backend unreachable
  }
  return null;
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const canonicalUrl = `${baseUrl}/playlist/${id}`;
  const playlist = await fetchPlaylistData(id);
  const songCount = playlist?.songs?.length || 0;
  const name = playlist?.name || "Playlist";

  return (
    <>
      {playlist && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "MusicPlaylist",
              "@id": canonicalUrl,
              name,
              url: canonicalUrl,
              description: `Listen to "${name}" — ${songCount} tracks curated on Strumm.`,
              numTracks: songCount,
              ...(playlist.description
                ? { abstract: playlist.description }
                : {}),
              ...(playlist.owner
                ? {
                    author: {
                      "@type": "Person",
                      name: playlist.owner.displayName || playlist.owner.username || "Strumm User",
                    },
                  }
                : {}),
            }),
          }}
        />
      )}
      <PlaylistDetailClient params={params} />
    </>
  );
}
