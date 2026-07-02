/**
 * MetadataNormalizer — converts raw YouTube Data API results into clean,
 * music-oriented metadata suitable for a streaming application.
 *
 * Architecture
 * ------------
 * The normalizer is a pure, stateless function pipeline.  Each raw YouTube
 * snippet passes through:
 *
 *   1. **cleanTitle**   — strip YouTube clutter, extract real song name
 *   2. **inferArtist**  — determine the correct artist via priority rules
 *   3. **generateCanonical** — create canonical strings for fuzzy dedup
 *
 * The result is a `NormalizedSong` that preserves raw values alongside
 * cleaned values so no information is ever lost.
 *
 * Future providers
 * ----------------
 * No YouTube-specific assumptions leak outside this file.  A MusicBrainz,
 * Spotify, or Last.fm normalizer would follow the same interface and
 * produce the same `NormalizedSong` shape.
 */


import type { NormalizedSong } from "./types";
import { canonicalString } from "./canonical";
import { canonicalArtist as canonicalArtistStr, normalizeArtist } from "./ArtistNormalizer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Phrases that, when found in a YouTube title, should be removed.
 * Order matters — longer / more specific patterns are listed first so they
 * match before shorter overlapping patterns.
 */
const TITLE_CLUTTER_PATTERNS: { pattern: RegExp; flags?: string }[] = [
  // --- Full phrases with flexible delimiters ---------------------------------
  { pattern: /(?:^|\s|-|\||—|:)\s*(?:Official\s+(?:Music\s+)?Video|Official\s+Audio|Official\s+Lyric\s+Video)\s*(?=$|\s|-|\||—|:)/gi },
  { pattern: /(?:^|\s|-|\||—|:)\s*Music\s+Video\s*(?=$|\s|-|\||—|:)/gi },
  { pattern: /(?:^|\s|-|\||—|:)\s*Lyric\s+Video\s*(?=$|\s|-|\||—|:)/gi },
  { pattern: /(?:^|\s|-|\||—|:)\s*Full\s+Song\s*(?=$|\s|-|\||—|:)/gi },
  { pattern: /(?:^|\s|-|\||—|:)\s*Video\s+Song\s*(?=$|\s|-|\||—|:)/gi },

  // --- Single-word clutter (but not "Lyrics" when preceded by " | " or similar) --
  { pattern: /\s*\(?\b(?:Lyrics|Lyrical)\b\)?\s*/gi },
  { pattern: /\s*\(?\b(?:HD|HQ|4K)\b\)?\s*/gi },
  { pattern: /\s*\(?\bVisualizer\b\)?\s*/gi },
  { pattern: /\s*\(?\bRemastered\b\)?\s*/gi },

  // --- Prefix patterns that add nothing ------------------------------------
  { pattern: /^(?:Lyrics?|Lyrical|Song|Video)\s*[:|-]\s*/gi },
];

/**
 * Patterns for parenthesised / bracketed content that should be removed
 * when the content is exclusively "noise" (no meaningful text).
 */
const BRACKET_NOISE_PATTERNS: RegExp[] = [
  /\((?:\s*(?:Official|Music\s+Video|Audio|Lyrics?|Lyric\s+Video|HD|HQ|4K|Full\s+Song|Video\s+Song|Visualizer|Remastered)\s*)\)/gi,
  /\[(?:\s*(?:Official|Music\s+Video|Audio|Lyrics?|Lyric\s+Video|HD|HQ|4K|Full\s+Song|Video\s+Song|Visualizer|Remastered)\s*)\]/gi,
  /\((?:\s*[Oo]fficial\s*)\)/g,
  /\[(?:\s*[Oo]fficial\s*)\]/g,
];

// ---------------------------------------------------------------------------
// Artist inference rules
// ---------------------------------------------------------------------------

/**
 * Channel-name patterns that indicate the channel is an artist's auto-generated
 * "Topic" channel.  The artist name appears before " - Topic".
 *
 * @example "KK - Topic" → artist: "KK"
 */
const TOPIC_CHANNEL_PATTERN = /^(.+?)\s*-\s*Topic$/i;

/**
 * Channel-name patterns that indicate the channel is a VEVO channel.
 * The artist name is extracted from the channel name.
 *
 * @example "ArijitSinghVEVO" → artist: "Arijit Singh"
 * @example "TaylorSwiftVEVO"  → artist: "Taylor Swift"
 */
const VEVO_CHANNEL_PATTERN = /^(.+?)VEVO$/i;

/**
 * Patterns that indicate "Official Artist Channels" where the channel name
 * contains the artist name + "Official" or similar suffix.
 *
 * @example "Pritam Official"  → artist: "Pritam"
 * @example "Arijit Singh"     → artist: "Arijit Singh" (no change)
 */
const OFFICIAL_CHANNEL_PATTERNS = [
  /^(.+?)\s+Official$/i,
  /^(.+?)\s+[Oo]n\s+[Ss]potify$/i,
  /^(.+?)\s+[Vv]evo$/i,
];

/**
 * Pattern to pipe-separated channel suffixes (common on YouTube).
 *
 * Matches ` | ChannelName` at the end of a title.
 *
 * @example "Aankhon Mein Teri Ajab Si | Om S" → "Aankhon Mein Teri Ajab Si"
 */
const PIPE_SUFFIX_PATTERN = /\s*\|\s*\S[\s\S]*$/;

/**
 * Pattern to extract artist from title when it follows the "Artist - Song" format.
 *
 * @example "KK - Aankhon Mein Teri" → artist: "KK", title cleaned to "Aankhon Mein Teri"
 * @example "Pritam - Phir Le Aaya Dil" → artist: "Pritam"
 *
 * To avoid treating reversed patterns ("Song Title - Artist Name") as artist-first,
 * the extracted artist candidate must be short (≤ 40 chars) and not appear to be
 * a full sentence or contain common song-like words.
 */
const ARTIST_DASH_TITLE_PATTERN = /^([^\-]+?)\s*-\s*(.+)$/;

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Clean a raw YouTube title by removing common clutter.
 *
 * The algorithm:
 *  1. Remove parenthesised / bracketed noise
 *  2. Remove known clutter phrases
 *  3. Remove leading/trailing delimiters (|, -, —, :)
 *  4. Collapse whitespace
 *  5. Trim
 */
export function cleanTitle(rawTitle: string): string {
  let title = rawTitle;

  // 1. Remove bracketed noise
  for (const pattern of BRACKET_NOISE_PATTERNS) {
    title = title.replace(pattern, "");
  }

  // 2. Remove known clutter phrases
  for (const { pattern } of TITLE_CLUTTER_PATTERNS) {
    title = title.replace(pattern, " ");
  }

  // 3. Remove leading/trailing delimiters and decorative symbols
  title = title.replace(/^[\s\-–—|:;.,/\\]+/, "");
  title = title.replace(/[\s\-–—|:;.,/\\]+$/, "");

  // 4. Remove emojis and decorative Unicode symbols
  title = title.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu,
    "",
  );

  // 5. Remove pipe-separated channel suffixes (e.g. "Song Title | ChannelName")
  title = title.replace(PIPE_SUFFIX_PATTERN, "");

  // 6. Collapse whitespace
  title = title.replace(/\s+/g, " ").trim();

  return title || rawTitle.trim();
}

/**
 * Infer the correct artist name using a priority system.
 *
 * Priority (high → low):
 *  1. Extract from title when in "Artist - Song" format
 *  2. Detect Topic channels → extract artist before " - Topic"
 *  3. Detect VEVO channels → extract artist before "VEVO"
 *  4. Detect Official Artist Channels → extract artist before "Official"
 *  5. Fall back to channelTitle
 *
 * @returns The inferred artist name
 */
export function inferArtist(title: string, channelTitle: string): string {
  // --- Priority 1: Extract from title ---
  // Only extract if the dash separator is followed by a non-trivial song name.
  // Heuristic: the left side is likely an artist when it is short (≤ 40 chars),
  // doesn't contain common song-preposition words, and the right side is longer
  // or contains typical song-title structure.
  const dashMatch = title.match(ARTIST_DASH_TITLE_PATTERN);
  if (dashMatch) {
    const extractedArtist = dashMatch[1].trim();
    const extractedSong = dashMatch[2].trim();
    // Valid artist indicators: short name, no song-like prepositions
    const songLikePrepositions = /\b(?:feat\.?|ft\.?|with|and|vs\.?|from|in|on|at|of|the|a|an)\b/i;
    if (
      extractedArtist.length > 0 &&
      extractedArtist.length <= 40 &&
      extractedSong.length > 0 &&
      !songLikePrepositions.test(extractedArtist) &&
      !/^(?:Official|Lyrics|Audio|Video|HD|HQ|4K)$/i.test(extractedArtist) &&
      // Prefer extraction when artist is shorter than song
      extractedArtist.length < extractedSong.length
    ) {
      return extractedArtist;
    }
  }

  // --- Priority 2: Topic channels ---
  const topicMatch = channelTitle.match(TOPIC_CHANNEL_PATTERN);
  if (topicMatch) {
    return topicMatch[1].trim();
  }

  // --- Priority 3: VEVO channels ---
  const vevoMatch = channelTitle.match(VEVO_CHANNEL_PATTERN);
  if (vevoMatch) {
    return vevoMatch[1].trim().replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  // --- Priority 4: Official Artist Channels ---
  for (const pattern of OFFICIAL_CHANNEL_PATTERNS) {
    const match = channelTitle.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  // --- Priority 5: Fall back to raw channelTitle ---
  return channelTitle;
}

/**
 * Normalize a single raw YouTube result into a `NormalizedSong`.
 *
 * @param videoId   - YouTube video ID
 * @param title      - Raw YouTube video title
 * @param channelTitle - YouTube channel title
 * @param thumbnail  - Thumbnail URL
 * @param duration   - Duration in seconds (may be 0 if unknown)
 *
 * @returns A fully resolved NormalizedSong
 */
export function normalizeSong(
  videoId: string,
  title: string,
  channelTitle: string,
  thumbnail: string,
  duration: number,
): NormalizedSong {
  const rawTitle = title;
  const rawChannel = channelTitle;

  // 1. Clean the title
  const cleanedTitle = cleanTitle(title);

  // 2. Infer the artist
  const artist = inferArtist(cleanedTitle || title, channelTitle);

  // 3. Apply artist-specific normalisation (strip Topic/VEVO/Official suffixes)
  const displayArtist = normalizeArtist(artist || "Unknown Artist");

  // 4. Build canonical forms (using ArtistNormalizer for artist-specific stripping)
  const canonicalTitleResult = canonicalString(cleanedTitle || rawTitle);
  const canonicalArtistResult = canonicalArtistStr(displayArtist);

  // 5. All YouTube Data API results have a valid videoId — hasVideo is always true
  const hasVideo = true;

  return {
    videoId,
    rawTitle,
    rawChannel,
    title: cleanedTitle || rawTitle,
    artist: displayArtist,
    canonicalTitle: canonicalTitleResult,
    canonicalArtist: canonicalArtistResult,
    hasVideo,
    thumbnail,
    duration,
  };
}

/**
 * Normalize an array of raw YouTube results.
 */
export function normalizeSongs(
  items: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    thumbnail: string;
    duration: number;
  }>,
): NormalizedSong[] {
  return items.map((item) =>
    normalizeSong(item.videoId, item.title, item.channelTitle, item.thumbnail, item.duration),
  );
}


