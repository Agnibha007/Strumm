/**
 * Video details API route — retrieves full metadata for a single YouTube
 * video (title, artist, thumbnail, duration) via the YouTubeProvider.
 */

import { NextRequest, NextResponse } from "next/server";
import { youTubeProvider } from "web/services/search";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get("id");

  if (!videoId) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'id' is required." },
      { status: 400 },
    );
  }

  try {
    const song = await youTubeProvider.getVideoDetails(videoId);
    if (!song) {
      return NextResponse.json(
        { success: false, data: null, error: "Video not found." },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { success: true, data: song },
      { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
    );
  } catch (err: any) {
    console.error("Video details error:", err?.message ?? err);
    return NextResponse.json(
      { success: false, data: null, error: "Failed to load video details." },
      { status: 500 },
    );
  }
}
