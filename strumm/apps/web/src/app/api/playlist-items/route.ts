/**
 * Playlist items API route — retrieves all songs in a YouTube playlist via
 * keyless public Piped instances (no server egress to YouTube).
 */

import { NextRequest, NextResponse } from "next/server";
import { invidiousProvider } from "web/services/search";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playlistId = searchParams.get("id");

  if (!playlistId) {
    return NextResponse.json(
      { success: false, error: "Query parameter 'id' is required." },
      { status: 400 },
    );
  }

  try {
    const songs = await invidiousProvider.getPlaylistItems(playlistId);
    return NextResponse.json(
      { success: true, data: songs },
      { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
    );
  } catch (err: any) {
    console.error("Playlist items error:", err?.message ?? err);
    return NextResponse.json(
      { success: true, data: [] },
      { status: 500 },
    );
  }
}