/**
 * Search API route — proxies search requests from the browser to the
 * YouTube Data API v3 via the YouTubeProvider, with an automatic fallback
 * to a public Piped instance (InvidiousProvider) when the API key is
 * missing or quota is exceeded.
 *
 * The browser never contacts YouTube directly.  All requests go through
 * this same-origin route, so there are no CORS issues.
 *
 * Requires the `YOUTUBE_API_KEY` environment variable to be set on the
 * Vercel/Next.js server for the primary path.
 */

import { NextRequest, NextResponse } from "next/server";
import { youTubeProvider, invidiousProvider, YouTubeAuthError } from "web/services/search";

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

  let warning: string | null = null;
  let results: { songs: any[]; albums: any[]; artists: any[] } | null = null;
  let source = "";

  // -----------------------------------------------------------------------
  // 1. Try YouTube Data API v3 (primary)
  // -----------------------------------------------------------------------
  try {
    results = await youTubeProvider.search(q, filter);
    source = youTubeProvider.name;
  } catch (err: any) {
    if (err instanceof YouTubeAuthError) {
      console.warn("YouTube API auth error, falling back to Piped:", err.message);
    } else {
      console.warn("YouTube API error, falling back to Piped:", err?.message ?? err);
    }
    warning = "YouTube search is temporarily unavailable. Using fallback search.";
  }

  // -----------------------------------------------------------------------
  // 2. Fallback: Invidious / Piped (when YouTube fails)
  // -----------------------------------------------------------------------
  if (!results) {
    try {
      results = await invidiousProvider.search(q, filter);
      source = invidiousProvider.name;
      if (!warning) {
        warning = "YouTube search is temporarily unavailable. Using fallback search.";
      }
    } catch (err: any) {
      console.error("Both YouTube API and Piped fallback failed:", err?.message ?? err);
      return NextResponse.json(
        {
          success: false,
          error: "Search is currently unavailable. Please try again later.",
          warning: "Both YouTube search and the Piped fallback are unavailable.",
          data: { songs: [], albums: [], artists: [] },
        },
        { status: 503 },
      );
    }
  }

  // -----------------------------------------------------------------------
  // 3. Check for empty results and set warning when appropriate
  // -----------------------------------------------------------------------
  if (results) {
    const response: Record<string, any> = {
      success: true as const,
      data: {
        songs: results.songs,
        albums: results.albums,
        artists: results.artists,
        source,
      },
    };

    // Attach warning when the primary provider failed and fallback was used
    if (warning) {
      response.warning = warning;
    }

    // Allow Vercel Edge / CDN to cache identical queries for 30 seconds
    // (shorter TTL when fallback is active so results refresh sooner)
    const maxAge = warning ? 30 : 60;
    return NextResponse.json(response, {
      headers: { "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}` },
    });
  }

  // Should not reach here, but handle gracefully
  return NextResponse.json(
    {
      success: false,
      error: "Search failed unexpectedly.",
      data: { songs: [], albums: [], artists: [] },
    },
    { status: 500 },
  );
}
