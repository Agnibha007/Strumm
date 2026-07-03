import { MetadataRoute } from "next";

// Use the same env var resolution as the rest of the frontend.
// IMPORTANT: For production builds, set NEXT_PUBLIC_APP_URL (frontend URL)
// and NEXT_PUBLIC_API_URL (backend API URL) so dynamic entries resolve correctly.
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

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

  // 1. Static routes
  const staticRoutes: Array<{
    path: string;
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
    priority: number;
  }> = [
    { path: "", changeFrequency: "daily", priority: 1.0 },
    { path: "/search", changeFrequency: "daily", priority: 0.8 },
    { path: "/podcasts", changeFrequency: "daily", priority: 0.8 },
    { path: "/playlists", changeFrequency: "weekly", priority: 0.7 },
    { path: "/library", changeFrequency: "weekly", priority: 0.5 },
    { path: "/lyrics", changeFrequency: "weekly", priority: 0.5 },
    { path: "/login", changeFrequency: "monthly", priority: 0.4 },
  ];

  const entries: MetadataRoute.Sitemap = staticRoutes.map((route) => ({
    url: `${baseUrl}${route.path}`,
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  // 2. Dynamic routes — fetch from backend API
  try {
    const response = await fetch(`${BACKEND_URL}/sitemap`, {
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) {
      const json: SitemapResponse = await response.json();

      if (json.success && json.data) {
        const { songs, playlists, podcasts, users } = json.data;

        // Song pages: /song/{videoId}
        for (const song of songs) {
          entries.push({
            url: `${baseUrl}/song/${song.videoId}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.6,
          });
        }

        // Public playlist pages: /playlist/{id}
        for (const playlist of playlists) {
          entries.push({
            url: `${baseUrl}/playlist/${playlist.id}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.5,
          });
        }

        // Podcast show pages: /podcasts/show/{id}
        for (const podcast of podcasts) {
          entries.push({
            url: `${baseUrl}/podcasts/show/${podcast.id}`,
            lastModified: new Date(),
            changeFrequency: "weekly" as const,
            priority: 0.5,
          });
        }

        // User profile pages: /public/{username}
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
    // Backend unreachable at build time — fallback to static + known-default entries
    // so the sitemap always has dynamic content for Google to crawl
    entries.push({
      url: `${baseUrl}/flow`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    });
    entries.push({
      url: `${baseUrl}/replay`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.5,
    });
    entries.push({
      url: `${baseUrl}/circle`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.5,
    });
    entries.push({
      url: `${baseUrl}/rooms`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.4,
    });
  }

  return entries;
}
