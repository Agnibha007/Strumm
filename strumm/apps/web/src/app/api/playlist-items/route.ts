import { NextRequest, NextResponse } from "next/server";

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.jing.rocks",
  "https://invidious.snopyta.org",
  "https://yewtu.be",
];

async function fetchJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playlistId = searchParams.get("id");

  if (!playlistId) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'id' is required." },
      { status: 400 },
    );
  }

  for (const instance of INVIDIOUS_INSTANCES) {
    const data = await fetchJson(`${instance}/api/v1/playlists/${playlistId}`);
    if (data && Array.isArray(data.videos)) {
      const songs = data.videos.map((v: any) => {
        const thumbs = v.videoThumbnails || [];
        const thumbUrl =
          thumbs.find((t: any) => t.quality === "medium")?.url ||
          thumbs.find((t: any) => t.quality === "hq720")?.url ||
          thumbs[0]?.url ||
          `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;

        return {
          videoId: v.videoId,
          title: v.title || "Untitled",
          artist: v.author || "Unknown Artist",
          thumbnail: thumbUrl,
          duration: v.lengthSeconds || 200,
        };
      });

      return NextResponse.json({ success: true, data: songs });
    }
  }

  return NextResponse.json({ success: true, data: [] });
}
