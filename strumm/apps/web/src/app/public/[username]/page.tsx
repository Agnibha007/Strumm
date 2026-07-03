import type { Metadata } from "next";
import PublicProfileClient from "./PublicProfileClient";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  const cleanUsername = decodeURIComponent(username).replace(/^@/, "");

  try {
    const res = await fetch(`${BACKEND_URL}/public/${encodeURIComponent(cleanUsername)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const json = await res.json();
    if (json.success && json.data) {
      const profile = json.data;
      const displayName = profile.displayName || cleanUsername;
      const totalMinutes = profile.totalMinutes || 0;

      return {
        title: `${displayName} (@${cleanUsername}) | Strumm Passport`,
        description: `View ${displayName}'s Strumm Passport — ${totalMinutes} minutes listened, Sound DNA, curated playlists, and song memories.`,
        openGraph: {
          title: `${displayName} (@${cleanUsername}) | Strumm Passport`,
          description: `Explore ${displayName}'s music passport on Strumm.`,
          url: `/public/${cleanUsername}`,
          images: profile.avatar ? [{ url: profile.avatar, width: 400, height: 400 }] : [],
          type: "profile",
        },
        twitter: {
          card: "summary",
          title: `${displayName} (@${cleanUsername}) | Strumm Passport`,
          description: `Explore ${displayName}'s music passport on Strumm.`,
        },
      };
    }
  } catch {
    // Backend unreachable — use generic metadata
  }

  return {
    title: `@${cleanUsername} | Strumm Passport`,
    description: `View this listener's Strumm Passport — music profile, Sound DNA, and curated playlists.`,
  };
}

export default function Page({ params }: { params: Promise<{ username: string }> }) {
  return <PublicProfileClient params={params} />;
}
