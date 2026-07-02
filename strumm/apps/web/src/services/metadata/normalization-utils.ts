/**
 * Shared normalization utilities for the Metadata Normalization Pipeline.
 *
 * Extracted to eliminate duplication between ArtistNormalizer.ts and
 * canonical.ts — both of which had their own NOISE_WORDS sets, emoji
 * stripping, diacritic handling, and Unicode normalisation.
 *
 * Every normalizer in this directory should import from here rather than
 * re-implementing these helpers.
 */

// ---------------------------------------------------------------------------
// Unicode normalisation
// ---------------------------------------------------------------------------

/** NFC-normalise a string (composed form). */
export function nfc(s: string): string {
  return s.normalize("NFC");
}

/** NFD-normalise a string and strip combining diacritical marks. */
export function stripDiacritics(s: string): string {
  const decomposed = s.normalize("NFD");
  return decomposed.replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------------
// Emoji / decorative Unicode removal
// ---------------------------------------------------------------------------

/** Regex that matches common emoji and decorative Unicode ranges. */
export const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{23F0}\u{23F3}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FB}\u{25FC}\u{25FD}\u{25FE}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

/** Strip emoji and decorative Unicode symbols from a string. */
export function stripEmojis(s: string): string {
  return s.replace(EMOJI_REGEX, "");
}

// ---------------------------------------------------------------------------
// Noise words
// ---------------------------------------------------------------------------

/**
 * Words that add no semantic value to song titles or artist names.
 *
 * These are removed during canonicalization so that "Aankhon Mein Teri
 * (Official Video)" and "Aankhon Mein Teri" produce the same canonical key.
 */
export const NOISE_WORDS = new Set([
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
  "artist",
  "vevo",
  "topic",
  "music",
  "records",
  "channel",
  "subject",
]);

// ---------------------------------------------------------------------------
// Canonical string builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical string from a raw title or artist name.
 *
 * Rules:
 *  1. NFC-normalise
 *  2. Lowercase
 *  3. Strip emojis
 *  4. Remove known noise words (whole word only)
 *  5. Remove punctuation except hyphens inside words
 *  6. Collapse whitespace
 *  7. Strip diacritics
 *  8. Trim
 */
export function buildCanonical(raw: string): string {
  let s = nfc(raw);

  // 1. Lowercase
  s = s.toLowerCase();

  // 2. Strip emojis
  s = stripEmojis(s);

  // 3. Remove noise words (whole word only)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
