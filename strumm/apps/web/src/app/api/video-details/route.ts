import { NextRequest, NextResponse } from "next/server";

const PIPED_API = "https://pipedapi.kavin.rocks";
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
  const videoId = searchParams.get("id");

  if (!videoId) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'id' is required." },
      { status: 400 },
    );
  }

  // Try Piped first
  const pipedData = await fetchJson(`${PIPED_API}/streams/${videoId}`);
  if (pipedData && pipedData.title) {
    const thumbs = pipedData.thumbnailUrl || pipedData.thumbnail || "";
    return NextResponse.json({
      success: true,
      data: {
        videoId,
        title: pipedData.title,
        artist: pipedData.uploader || pipedData.uploaderName || "Unknown Artist",
        thumbnail: typeof thumbs === "string" && thumbs.startsWith("http")
          ? thumbs
          : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: pipedData.duration || 0,
      },
    });
  }

  // Fall back to Invidious
  for (const instance of INVIDIOUS_INSTANCES) {
    const data = await fetchJson(`${instance}/api/v1/videos/${videoId}`);
    if (data && data.videoId) {
      const thumbs = data.videoThumbnails || [];
      const thumbUrl =
        thumbs.find((t: any) => t.quality === "medium")?.url ||
        thumbs.find((t: any) => t.quality === "hq720")?.url ||
        thumbs[0]?.url ||
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

      return NextResponse.json({
        success: true,
        data: {
          videoId: data.videoId,
          title: data.title || "Untitled",
          artist: data.author || "Unknown Artist",
          thumbnail: thumbUrl,
          duration: data.lengthSeconds || 200,
        },
      });
    }
  }

  return NextResponse.json({
    success: false,
    data: null,
    error: "Video not found.",
  });
}
