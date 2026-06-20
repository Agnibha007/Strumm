import { MetadataRoute } from "next";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://strumm.pixelneststudios.tech";
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
  
  return staticRoutes.map((route) => ({
    url: `${baseUrl}${route.path}`,
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
