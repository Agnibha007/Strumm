import { Metadata } from "next";
import PodcastEpisodeClient from "./PodcastEpisodeClient";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

async function fetchPodcastEpisode(id: string) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`${BACKEND_URL}/podcasts/episode/${id}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const json = await response.json();
    return json?.success ? json.data : null;
  } catch {
    return null;
  }
}

interface PodcastEpisodePageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PodcastEpisodePageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await fetchPodcastEpisode(id);

  if (!data) {
    return {
      title: "Podcast Episode | Strumm",
      description: "Listen to this podcast episode on Strumm.",
      openGraph: {
        title: "Podcast Episode | Strumm",
        description: "Listen to this podcast episode on Strumm.",
        type: "website",
      },
    };
  }

  const episode = data.episode;
  const show = data.show;
  const episodeTitle = episode?.title || "Podcast Episode";
  const showTitle = show?.title || "Strumm";
  const description = episode?.description
    ? episode.description.replace(/<[^>]*>/g, "").slice(0, 300)
    : `Listen to ${episodeTitle} from ${showTitle} on Strumm.`;
  const image = show?.image || "";

  return {
    title: `${episodeTitle} — ${showTitle}`,
    description,
    openGraph: {
      title: `${episodeTitle} — ${showTitle}`,
      description,
      type: "website",
      images: image ? [{ url: image, width: 800, height: 800 }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: `${episodeTitle} — ${showTitle}`,
      description,
      images: image ? [image] : [],
    },
  };
}

export default async function PodcastEpisodePage({ params }: PodcastEpisodePageProps) {
  const { id } = await params;
  const data = await fetchPodcastEpisode(id);
  const showTitle = data?.show?.title || "Podcast Show";
  const episodeTitle = data?.episode?.title || "Episode";

  return (
    <>
      <BreadcrumbJsonLd items={[
        { name: "Home", href: "/" },
        { name: "Podcasts", href: "/podcasts" },
        { name: showTitle, href: "/podcasts" },
        { name: episodeTitle, href: `/podcast/${id}` },
      ]} />
      <PodcastEpisodeClient params={params} />
    </>
  );
}
