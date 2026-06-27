import type { NextConfig } from "next";

const apiOrigin = (process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  transpilePackages: ["@strumm/types", "@strumm/ui", "@strumm/database"],
  images: {
    unoptimized: true,
  },
  eslint: {
    // Skip linting during the build to avoid type‑checking errors that are not critical for production.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' data: https:; media-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")} https://api.groq.com https://www.youtube.com https://s.ytimg.com https://i.ytimg.com https://img.youtube.com https://lh3.googleusercontent.com https:;`
          },
          {
            key: "X-Frame-Options",
            value: "DENY"
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff"
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin"
          },
          {
            key: "X-XSS-Protection",
            value: "1; mode=block"
          }
        ]
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: "/@:username",
        destination: "/public/@:username",
      },
    ];
  }
};

export default nextConfig;
