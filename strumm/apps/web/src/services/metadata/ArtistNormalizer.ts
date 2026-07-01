/**
 * ArtistNormalizer — the single source of truth for artist name normalization.
 *
 * Two distinct operations:
 *   1. `normalizeArtist()` — strips YouTube channel suffixes (Topic, VEVO,
 *      Official, Music, Records, Channel) from an artist name for clean display.
 *   2. `canonicalArtist()` — produces a canonical key for grouping/dedup
 *      (lowercase, no punctuation, no noise words).
 *
 * These are separate from the title normalization in MetadataNormalizer.ts
 * because artist names have their own suffix patterns and normalization needs.
 */

// ---------------------------------------------------------------------------
// YouTube channel suffix patterns
// ---------------------------------------------------------------------------

/** Suffixes to strip from artist names for canonicalization. */
const ARTIST_SUFFIX_PATTERNS = [
  // Order matters — more specific first
  /\s*-\s*Topic\s*$/i,            // "Arijit Singh - Topic"
  /\s*Official\s+Artist\s*$/i,     // "Arijit Singh Official Artist"
  /\s*Official\s*$/i,               // "Arijit Singh Official"
  /\s*VEVO\s*$/i,                   // "ArijitSinghVEVO", "Arijit Singh VEVO"
  /\s*[Oo]n\s+[Ss]potify\s*$/i,    // "Arijit Singh On Spotify"
  /\s*Music\s*$/i,                  // "Arijit Singh Music"
  /\s*Records\s*$/i,                // "Arijit Singh Records"
  /\s*Channel\s*$/i,                // "Arijit Singh Channel"
  /\s*-\s*Subject\s*$/i,           // "Arijit Singh - Subject"
];

/** Words that should be removed from the canonical artist key. */
const CANONICAL_ARTIST_NOISE = new Set([
  "official",
  "artist",
  "vevo",
  "topic",
  "music",
  "records",
  "channel",
  "subject",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nfc(s: string): string {
  return s.normalize("NFC");
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize an artist name by stripping YouTube channel suffixes.
 *
 * The result is a clean, human-readable artist name suitable for display.
 * This does NOT lowercase — it preserves casing for the UI.
 *
 * @example
 *   normalizeArtist("Arijit Singh - Topic")    → "Arijit Singh"
 *   normalizeArtist("ArijitSinghVEVO")         → "ArijitSingh" (see canonicalArtist for splitting)
 *   normalizeArtist("Pritam Official")         → "Pritam"
 *   normalizeArtist("Taylor Swift Music")      → "Taylor Swift"
 */
export function normalizeArtist(artist: string): string {
  if (!artist) return artist;

  let normalized = artist.trim();

  // Apply suffix patterns
  for (const pattern of ARTIST_SUFFIX_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }

  // Handle VEVO suffix attached without space (camelCase)
  // e.g. "ArijitSinghVEVO" → "ArijitSingh" (the VEVO part is removed by the pattern above)
  // But also handle the case where VEVO is appended without space:
  // "ArijitSinghVEVO" → after stripping VEVO: "ArijitSingh"
  // Then split CamelCase: "Arijit Singh"
  normalized = normalized.replace(/([a-z])([A-Z])/g, "$1 $2");

  return normalized.trim() || artist.trim();
}

/**
 * Build a canonical artist key for grouping, dedup, and comparison.
 *
 * Rules:
 *  1. NFC-normalize
 *  2. Lowercase
 *  3. Strip emojis
 *  4. Remove known noise words (official, vevo, topic, music, records, channel)
 *  5. Remove punctuation except hyphens inside words
 *  6. Collapse whitespace
 *  7. Strip diacritics
 *  8. Trim
 *
 * @example
 *   canonicalArtist("ARIJIT SINGH")        → "arijit singh"
 *   canonicalArtist("Arijit Singh Official") → "arijit singh"
 *   canonicalArtist("ArijitSinghVEVO")     → "arijit singh"
 */
export function canonicalArtist(raw: string): string {
  if (!raw) return raw;

  let s = nfc(raw);

  // 1. Lowercase
  s = s.toLowerCase();

  // 2. Strip emojis
  s = s.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu,
    "",
  );

  // 3. Apply suffix stripping (handle " - topic", "official", "vevo" etc.)
  for (const pattern of ARTIST_SUFFIX_PATTERNS) {
    s = s.replace(pattern, "");
  }

  // 4. Handle camelCase VEVO
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");

  // 5. Remove noise words (whole word only)
  const noisePattern = new RegExp(
    `\\b(?:${[...CANONICAL_ARTIST_NOISE].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "gi",
  );
  s = s.replace(noisePattern, "");

  // 6. Remove punctuation except hyphens inside words
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, " ");

  // 7. Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  // 8. Strip diacritics
  s = stripDiacritics(s);

  return s;
}

/**
 * Check whether two artist names refer to the same real-world artist.
 */
export function areSameArtist(a: string, b: string): boolean {
  return canonicalArtist(a) === canonicalArtist(b);
}
