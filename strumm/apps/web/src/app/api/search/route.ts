/**
 * Search API route — proxies search requests from the browser to the
 * YouTube Data API v3 via the YouTubeProvider.
 *
 * The browser never contacts YouTube directly.  All requests go through
 * this same-origin route, so there are no CORS issues.
 *
 * Requires the `YOUTUBE_API_KEY` environment variable to be set on the
 * Vercel/Next.js server.
 */

import { NextRequest, NextResponse } from "next/server";
import { youTubeProvider, YouTubeAuthError } from "web/services/search";

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const type = searchParams.get("type") || "all";

  if (!q || !q.trim()) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'q' is required." },
      { status: 400 },
    );
  }

  const validTypes = ["all", "video", "playlist", "channel"];
  const filter = validTypes.includes(type) ? type : "all";

  try {
    // Source: YouTubeProvider (YouTube Data API v3)
    const results = await youTubeProvider.search(q, filter);

    const response = {
      success: true as const,
      data: {
        songs: results.songs,
        albums: results.albums,
        artists: results.artists,
        source: youTubeProvider.name,
      },
    };

    // Allow Vercel Edge / CDN to cache identical queries for 60 seconds
    return NextResponse.json(response, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
    });
  } catch (err: any) {
    // Auth errors (invalid key / quota exceeded) get a clear message
    if (err instanceof YouTubeAuthError) {
      console.error("YouTube API auth error:", err.message);
      return NextResponse.json(
        {
          success: false,
          error: "YouTube search is not available. Please check server configuration.",
          data: { songs: [], albums: [], artists: [] },
        },
        { status: 503 },
      );
    }

    console.error("Search API error:", err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        error: "Search failed. Please try again.",
        data: { songs: [], albums: [], artists: [] },
      },
      { status: 500 },
    );
  }
}
