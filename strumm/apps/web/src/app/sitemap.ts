import { MetadataRoute } from "next";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000";

interface SitemapSong {
  videoId: string;
  title: string;
}

interface SitemapPlaylist {
  id: string;
  name: string;
}

interface SitemapPodcast {
  id: string;
  title: string;
}

interface SitemapUser {
  username: string;
  displayName: string;
}

interface SitemapResponse {
  success: boolean;
  data: {
    songs: SitemapSong[];
    playlists: SitemapPlaylist[];
    podcasts: SitemapPodcast[];
    users: SitemapUser[];
  };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Static routes — ordered by priority
  const staticRoutes: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
    priority: number;
  }> = [
    { path: "", changeFrequency: "daily", priority: 1.0 },
    { path: "/search", changeFrequency: "daily", priority: 0.9 },
    { path: "/flow", changeFrequency: "daily", priority: 0.8 },
    { path: "/podcasts", changeFrequency: "daily", priority: 0.8 },
    { path: "/playlists", changeFrequency: "weekly", priority: 0.7 },
    { path: "/replay", changeFrequency: "weekly", priority: 0.6 },
    { path: "/circle", changeFrequency: "weekly", priority: 0.6 },
    { path: "/library", changeFrequency: "weekly", priority: 0.5 },
    { path: "/lyrics", changeFrequency: "weekly", priority: 0.5 },
    { path: "/rooms", changeFrequency: "weekly", priority: 0.5 },
    { path: "/about", changeFrequency: "monthly", priority: 0.4 },
    { path: "/faq", changeFrequency: "monthly", priority: 0.4 },
    { path: "/contact", changeFrequency: "monthly", priority: 0.3 },
    { path: "/privacy", changeFrequency: "monthly", priority: 0.3 },
    { path: "/terms", changeFrequency: "monthly", priority: 0.3 },
    { path: "/cookies", changeFrequency: "monthly", priority: 0.2 },
    { path: "/dmca", changeFrequency: "monthly", priority: 0.2 },
    { path: "/security", changeFrequency: "monthly", priority: 0.2 },
    { path: "/credits", changeFrequency: "monthly", priority: 0.1 },
    { path: "/changelog", changeFrequency: "monthly", priority: 0.1 },
    { path: "/status", changeFrequency: "daily", priority: 0.3 },
    { path: "/login", changeFrequency: "monthly", priority: 0.2 },
    { path: "/feedback", changeFrequency: "monthly", priority: 0.2 },
    { path: "/feature-request", changeFrequency: "monthly", priority: 0.1 },
    { path: "/report-bug", changeFrequency: "monthly", priority: 0.1 },
    { path: "/content-removal", changeFrequency: "monthly", priority: 0.1 },
    { path: "/roadmap", changeFrequency: "weekly", priority: 0.4 },
    { path: "/licenses", changeFrequency: "monthly", priority: 0.1 },
  ];

  const entries: MetadataRoute.Sitemap = staticRoutes.map((route) => ({
    url: `${baseUrl}${route.path}`,
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  // Dynamic routes — fetch from backend API
  try {
    const response = await fetch(`${BACKEND_URL}/sitemap`, {
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) {
      const json: SitemapResponse = await response.json();

      if (json.success && json.data) {
        const { songs, playlists, podcasts, users } = json.data;

        for (const song of songs) {
          entries.push({
            url: `${baseUrl}/song/${song.videoId}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.6,
          });
        }

        for (const playlist of playlists) {
          entries.push({
            url: `${baseUrl}/playlist/${playlist.id}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.5,
          });
        }

        for (const podcast of podcasts) {
          entries.push({
            url: `${baseUrl}/podcasts/show/${podcast.id}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.5,
          });
        }

        for (const user of users) {
          entries.push({
            url: `${baseUrl}/public/${user.username}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.4,
          });
        }
      }
    }
  } catch {
    // Backend unreachable — dynamic entries already have static fallbacks above
  }

  return entries;
}
