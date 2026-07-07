import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/_next/",
          "/settings/",
          "/profile/",
          "/401",
          "/403",
          "/429",
          "/503",
          "/maintenance",
          "/offline",
        ],
      },
      {
        userAgent: "Googlebot-Image",
        allow: ["/*.png", "/*.jpg", "/*.webp"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
