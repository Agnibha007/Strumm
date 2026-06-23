import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://strumm.pixelneststudios.tech";
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/_next/", "/static/", "/settings/", "/profile/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
