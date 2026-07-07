import type { Metadata } from "next";
import PodcastShowClient from "./PodcastShowClient";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

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

async function fetchPodcastShow(id: string): Promise<PodcastShowData | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/podcasts/shows/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) return json.data as PodcastShowData;
  } catch {
    // Backend unreachable
  }
  return null;
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const canonicalUrl = `${baseUrl}/podcasts/show/${id}`;
  const data = await fetchPodcastShow(id);

  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Podcasts", href: "/podcasts" },
        { name: data?.show?.title || "Podcast Show", href: `/podcasts/show/${id}` },
      ]} />
      {data && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "PodcastSeries",
              "@id": canonicalUrl,
              name: data.show.title,
              url: canonicalUrl,
              description: data.show.description
                ? data.show.description.replace(/<[^>]*>/g, "").slice(0, 500)
                : `Listen to "${data.show.title}" on Strumm.`,
              image: data.show.image
                ? { "@type": "ImageObject", url: data.show.image }
                : undefined,
              author: {
                "@type": "Person",
                name: data.show.author,
              },
              ...(data.episodes?.length > 0
                ? {
                    numberOfEpisodes: data.episodes.length,
                  }
                : {}),
            }),
          }}
        />
      )}
      <PodcastShowClient params={params} />
    </>
  );
}
