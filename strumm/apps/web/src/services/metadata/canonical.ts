/**
 * Canonical string helpers for the Metadata Normalization Pipeline.
 *
 * These functions produce normalised, punctuation-free, whitespace‑collapsed
 * strings that can be compared for fuzzy duplicate detection without
 * worrying about casing, diacritics, or decorative noise.
 */

// ---------------------------------------------------------------------------
// Unicode normalisation
// ---------------------------------------------------------------------------

/** NFC-normalise a string (composed form). */
function nfc(s: string): string {
  return s.normalize("NFC");
}

/** NFD-normalise a string and strip combining diacritical marks. */
function stripDiacritics(s: string): string {
  const decomposed = s.normalize("NFD");
  return decomposed.replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------------
// Noise-word sets
// ---------------------------------------------------------------------------

/** Words that add no semantic value and should be removed from canonical form. */
const NOISE_WORDS = new Set([
  "official",
  "lyrics",
  "lyric",
  "video",
  "audio",
  "remastered",
  "hd",
  "hq",
  "4k",
  "visualizer",
  "full song",
  "song",
  "music video",
]);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Build a canonical string from a raw title or artist name.
 *
 * Rules:
 *  1. Lowercase
 *  2. Remove emojis (Unicode symbols & pictographs)
 *  3. Remove known noise words (official, lyrics, hd, …)
 *  4. Remove all punctuation (keep letters, digits, spaces, hyphens)
 *  5. Collapse whitespace
 *  6. Strip diacritics (é → e)
 *  7. Trim
 *
 * @example
 *   canonicalString("Lyrics: Aankhon Mein Teri (Official Video)")
 *   // → "aankhon me teri"
 *
 * @example
 *   canonicalString("KK Official")
 *   // → "kk"
 */
export function canonicalString(raw: string): string {
  let s = nfc(raw);

  // 1. Lowercase
  s = s.toLowerCase();

  // 2. Strip emojis and other decorative Unicode symbols
  s = s.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{23F0}\u{23F3}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FB}\u{25FC}\u{25FD}\u{25FE}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu,
    "",
  );

  // 3. Remove noise words (whole word only)
  //    Build a pattern: \b(?:word1|word2|...)\b
  const noisePattern = new RegExp(
    `\\b(?:${[...NOISE_WORDS].map((w) => escapeRegExp(w)).join("|")})\\b`,
    "gi",
  );
  s = s.replace(noisePattern, "");

  // 4. Remove punctuation except hyphens inside words
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, " ");

  // 5. Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  // 6. Strip diacritics
  s = stripDiacritics(s);

  return s;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
