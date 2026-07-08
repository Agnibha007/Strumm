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

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const cleanUsername = decodeURIComponent(username).replace(/^@/, "");
  const canonicalUrl = `${baseUrl}/public/${cleanUsername}`;

  // Fetch profile data for Person schema
  let profile: { displayName?: string; avatar?: string; totalMinutes?: number } | null = null;
  try {
    const res = await fetch(`${BACKEND_URL}/public/${encodeURIComponent(cleanUsername)}`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = await res.json();
    if (json.success && json.data) profile = json.data;
  } catch {
    // Backend unreachable — Person schema still uses username
  }

  const displayName = profile?.displayName || cleanUsername;

  return (
    <>
      {/* Person/Profile structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Person",
            "@id": canonicalUrl,
            name: displayName,
            url: canonicalUrl,
            ...(profile?.avatar
              ? { image: { "@type": "ImageObject", url: profile.avatar } }
              : {}),
            description: `${displayName}'s Strumm music passport — ${profile?.totalMinutes || 0} minutes listened, curated playlists, and Sound DNA.`,
            memberOf: {
              "@type": "Organization",
              name: "Strumm",
            },
          }),
        }}
      />
      <PublicProfileClient params={params} />
    </>
  );
}
