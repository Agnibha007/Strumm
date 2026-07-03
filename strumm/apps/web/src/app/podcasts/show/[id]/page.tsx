import type { Metadata } from "next";
import PodcastShowClient from "./PodcastShowClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

interface PodcastShowData {
  show: {
    title: string;
    author: string;
    description: string;
    image: string;
  };
  episodes: unknown[];
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;

  try {
    const res = await fetch(`${BACKEND_URL}/podcasts/shows/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) {
      const data = json.data as PodcastShowData;
      const show = data.show;
      const episodeCount = data.episodes?.length || 0;

      return {
        title: `${show.title} | Strumm Podcasts`,
        description: show.description
          ? show.description.replace(/<[^>]*>/g, "").slice(0, 300)
          : `Listen to "${show.title}" — ${episodeCount} episodes by ${show.author} on Strumm.`,
        openGraph: {
          title: `${show.title} | Strumm Podcasts`,
          description: show.description
            ? show.description.replace(/<[^>]*>/g, "").slice(0, 200)
            : `Listen to "${show.title}" — ${episodeCount} episodes on Strumm.`,
          url: `/podcasts/show/${id}`,
          images: show.image ? [{ url: show.image, width: 600, height: 600 }] : [],
          type: "website",
        },
        twitter: {
          card: "summary_large_image",
          title: `${show.title} | Strumm Podcasts`,
          description: show.description
            ? show.description.replace(/<[^>]*>/g, "").slice(0, 200)
            : `Listen to "${show.title}" — ${episodeCount} episodes on Strumm.`,
          images: show.image ? [show.image] : [],
        },
      };
    }
  } catch {
    // Backend unreachable — use generic metadata
  }

  return {
    title: `Podcast Show | Strumm`,
    description: "Discover and stream podcast shows on Strumm.",
  };
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PodcastShowClient params={params} />;
}
