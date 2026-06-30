/**
 * SearchProvider — abstract interface for YouTube music search providers.
 *
 * Each provider implements the same contract so the API route never calls
 * a specific provider directly.  This makes it easy to add future providers
 * (e.g. a self-hosted Invidious instance, Spotify API, etc.).
 */

// ---------------------------------------------------------------------------
// Normalised result types (used by the API route → frontend)
// ---------------------------------------------------------------------------

export interface SongResult {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number; // seconds
}

export interface AlbumResult {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  year: string;
}

export interface ArtistResult {
  id: string;
  name: string;
  thumbnail: string;
}

export interface SearchResults {
  songs: SongResult[];
  albums: AlbumResult[];
  artists: ArtistResult[];
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface SearchProvider {
  /** Human-readable label (used for debugging / telemetry). */
  readonly name: string;

  /**
   * Search across videos (songs), playlists (albums) and channels (artists).
   *
   * @param q    – search query
   * @param type – one of "all" | "video" | "playlist" | "channel"
   */
  search(q: string, type: string): Promise<SearchResults>;

  /** Get full details for a single video (by YouTube video id). */
  getVideoDetails(videoId: string): Promise<SongResult | null>;

  /** Get all items inside a playlist (by YouTube playlist id). */
  getPlaylistItems(playlistId: string): Promise<SongResult[]>;
}
