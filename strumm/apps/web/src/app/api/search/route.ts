/**
 * Search API route — resolves searches via keyless public Piped instances only.
 *
 * Requests to YouTube are never made from this server. The route and the
 * browser-side ``searchYouTube`` client both talk to Piped (a privacy-facing
 * YouTube proxy), which performs the YouTube request itself. The route exists
 * as a same-origin fallback so the browser never has to hold the Piped
 * instance list / CORS concern on its own.
 */

import { NextRequest, NextResponse } from "next/server";
import { invidiousProvider } from "web/services/search";

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
    const pipedResults = await invidiousProvider.search(q, filter);
    const hasResults =
      pipedResults &&
      (pipedResults.songs.length > 0 || pipedResults.albums.length > 0 || pipedResults.artists.length > 0);

    if (hasResults) {
      const response: Record<string, any> = {
        success: true as const,
        data: {
          songs: pipedResults.songs,
          albums: pipedResults.albums,
          artists: pipedResults.artists,
          source: invidiousProvider.name,
        },
      };
      return NextResponse.json(response, {
        headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
      });
    }

    return NextResponse.json(
      {
        success: false,
        error: "No results found.",
        data: { songs: [], albums: [], artists: [] },
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("Search failed:", err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        error: "Search is currently unavailable. Please try again later.",
        data: { songs: [], albums: [], artists: [] },
      },
      { status: 503 },
    );
  }
}