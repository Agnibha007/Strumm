/**
 * Canonical string helpers for the Metadata Normalization Pipeline.
 *
 * These functions produce normalised, punctuation-free, whitespace‑collapsed
 * strings that can be compared for fuzzy duplicate detection without
 * worrying about casing, diacritics, or decorative noise.
 *
 * Uses shared utilities from normalization-utils.ts to avoid duplication
 * with ArtistNormalizer.ts.
 */

import { buildCanonical } from "./normalization-utils";

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Build a canonical string from a raw title or artist name.
 *
 * Uses `buildCanonical()` from normalization-utils.ts which applies:
 *  1. NFC-normalise
 *  2. Lowercase
 *  3. Strip emojis
 *  4. Remove known noise words
 *  5. Remove punctuation
 *  6. Collapse whitespace
 *  7. Strip diacritics
 *
 * @example
 *   canonicalString("Lyrics: Aankhon Mein Teri (Official Video)")
 *   // → "aankhon me teri"
 */
export function canonicalString(raw: string): string {
  return buildCanonical(raw);
}

/**
 * Build a canonical song key for duplicate comparison.
 *
 * Returns `"canonicalTitle|canonicalArtist"` so both fields are
 * compared together.
 */
export function canonicalSongKey(title: string, artist: string): string {
  return `${canonicalString(title)}|${canonicalString(artist)}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------


