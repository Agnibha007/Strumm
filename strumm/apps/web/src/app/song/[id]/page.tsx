import type { Metadata } from "next";
import SongDetailClient from "./SongDetailClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const canonicalUrl = `${baseUrl}/song/${id}`;

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
        alternates: { canonical: canonicalUrl },
        openGraph: {
          title: `${title} — ${artist} | Strumm`,
          description: `Listen to "${title}" by ${artist} on Strumm.`,
          url: canonicalUrl,
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
    alternates: { canonical: canonicalUrl },
  };
}

async function fetchSongData(id: string) {
  try {
    const res = await fetch(`${BACKEND_URL}/resolve/${encodeURIComponent(id)}`, {
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
  const canonicalUrl = `${baseUrl}/song/${id}`;
  const song = await fetchSongData(id);

  return (
    <>
      {song && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "MusicRecording",
              "@id": canonicalUrl,
              name: song.title || "Unknown Track",
              url: canonicalUrl,
              description: `Listen to "${song.title || "Unknown Track"}" by ${song.artist || "Unknown Artist"} on Strumm.`,
              byArtist: {
                "@type": "MusicGroup",
                name: song.artist || "Unknown Artist",
              },
              ...(song.thumbnail
                ? { image: { "@type": "ImageObject", url: song.thumbnail } }
                : {}),
              ...(song.duration
                ? { duration: `PT${Math.floor(song.duration)}S` }
                : {}),
              isPartOf: {
                "@type": "MusicAlbum",
                name: `${song.title || "Song"} — Single`,
              },
            }),
          }}
        />
      )}
      <SongDetailClient params={params} />
    </>
  );
}
