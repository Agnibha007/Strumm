/**
 * Types for the Metadata Normalization Pipeline.
 *
 * These extend the base `SongResult` with raw YouTube fields and canonical
 * forms used for duplicate detection.  The `title` and `artist` fields
 * on `SongResult` always contain the **cleaned** values that the frontend
 * displays.  Raw values are preserved alongside them for internal use.
 *
 * Future provider integration
 * ---------------------------
 * This layer is provider-agnostic.  A MusicBrainz, Last.fm, or Spotify
 * provider would produce the same `NormalizedSong` shape, so the frontend
 * never needs to change when new backends are added.
 */

import type { SongResult } from "../search/SearchProvider";

// ---------------------------------------------------------------------------
// Core normalised type (extends SongResult — fully backward compatible)
// ---------------------------------------------------------------------------

/**
 * A fully normalised song with raw, cleaned, and canonical fields.
 *
 * Extends `SongResult` so every existing frontend component that expects
 * `SongResult` keeps working without modifications.  Raw / canonical
 * fields are optional at the type level for the same reason, but the
 * normalizer always fills them.
 */
export interface NormalizedSong extends SongResult {
  /** Original YouTube video title (preserved, never modified). */
  rawTitle: string;

  /** Original YouTube channel title (preserved, never modified). */
  rawChannel: string;

  /**
   * Canonical form of the cleaned title — lowercase, punctuation-free,
   * whitespace-collapsed, emoji-free, with "noise" words removed.
   * Used for fuzzy duplicate detection.
   */
  canonicalTitle: string;

  /**
   * Canonical form of the inferred artist — same normalisation as
   * `canonicalTitle`.
   */
  canonicalArtist: string;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Strip canonical fields from a NormalizedSong, returning a plain
 * SongResult that the frontend can consume.
 */
export function toSongResult(ns: NormalizedSong): SongResult {
  // Destructure only canonical/raw fields, keep everything else
  const { rawTitle, rawChannel, canonicalTitle, canonicalArtist, ...result } = ns;
  return result;
}

/**
 * Create a plain Song display object from a NormalizedSong.
 * Keeps only fields needed for UI rendering.
 */
export function toDisplaySong(ns: NormalizedSong): {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
} {
  return {
    videoId: ns.videoId,
    title: ns.title,
    artist: ns.artist,
    thumbnail: ns.thumbnail,
    duration: ns.duration,
  };
}
