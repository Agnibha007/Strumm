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
import { decodeHtml } from "web/lib/api";

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
// Music label channel detection
// ---------------------------------------------------------------------------

/**
 * Known music label / record company channels that upload songs but are
 * NOT the actual artist.  When a channel is a label, the artist name must
 * come from the video title, never from the channel name.
 *
 * This set is case-insensitive (compared after toLowerCase()).
 */
const MUSIC_LABEL_CHANNELS = new Set([
  // Indian labels
  "t-series",
  "tseries",
  "sony music india",
  "zee music company",
  "tips official",
  "tips music",
  "wave music",
  "speed records",
  "times music",
  "saregama music",
  "saregama",
  "venus music",
  "venus records",
  "t series",
  "t-series official",
  "sony music entertainment india",
  "sony music india • best of",
  "tseries music",
  "tseries official",
  "warnermusic india",
  "warner music india",
  // International labels
  "vevo",
  "umg",
  "universal music group",
  "wmg",
  "warner music group",
  "sony music entertainment",
  "atlantic records",
  "columbia records",
  "epic records",
  "capitol records",
  "island records",
  "interscope records",
  "rca records",
  "republic records",
  "def jam",
  "xfy",
]);

/**
 * Regex patterns for channel names that strongly suggest a label/company
 * rather than an individual artist.  Channel names matching these patterns
 * should NOT be used as the artist name.
 */
const LABEL_CHANNEL_PATTERNS = [
  /^(?:[\w\s.&'-]+)\s+(?:music|records?|recordings?|label|labels?|company|production|entertainment|official|network|digital|media|inc\.?|corp\.?|limited|ltd\.?)\s*$/i,
  /^(?:the\s+)?(?:music|records?|label)\s+(?:factory|company|group|network|hub|studio)\s*$/i,
];

/** Check if a channel name belongs to a music label rather than an artist. */
function isLabelChannel(channelTitle: string): boolean {
  const lower = channelTitle.toLowerCase().trim();
  if (MUSIC_LABEL_CHANNELS.has(lower)) return true;
  for (const pattern of LABEL_CHANNEL_PATTERNS) {
    if (pattern.test(channelTitle)) return true;
  }
  return false;
}

/**
 * Heuristic: check whether a string looks like a reasonable artist name
 * (as opposed to a song title).  Used to distinguish "Artist - Song" from
 * "Song - Artist" in title patterns.
 */
function isReasonableArtist(candidate: string): boolean {
  if (!candidate || candidate.length < 1 || candidate.length > 40) return false;
  // Reject obvious clutter words
  if (/^(?:Official|Lyrics?|Audio|Video|HD|HQ|4K|Full|Song|Music)$/i.test(candidate)) return false;
  // Artists with special characters like commas are still valid (e.g. "Tyler, The Creator")
  return true;
}

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
  // --- Priority 1: Extract from title (both "Artist - Song" and "Song - Artist") ---
  const dashMatch = title.match(ARTIST_DASH_TITLE_PATTERN);
  if (dashMatch) {
    const left = dashMatch[1].trim();
    const right = dashMatch[2].trim();
    const channelIsLabel = isLabelChannel(channelTitle);

    // Score both sides for artist-likelihood.
    // Key signals (strongest first):
    //   1. Candidate appears in channel name  →  4 pts
    //   2. Candidate has fewer words than the other side  →  3 pts
    //      (artist names are typically 1-3 words; song titles are often longer phrases)
    //   3. Candidate is shorter (chars) than the other side  →  1 pt
    //   4. Channel is a label (so title is the only source of truth)  →  1 pt
    const matchesChannel = (name: string) => {
      const lowerChannel = channelTitle.toLowerCase();
      const lowerName = name.toLowerCase();
      // Word-boundary match first (prevents "series" matching "tseries")
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(channelTitle)) return true;
      // Fallback: exact substring handles camelCase channels like "ArijitSingh"
      return lowerChannel.includes(lowerName);
    };
    const countWords = (s: string) => s.trim().split(/\s+/).length;

    const score = (candidate: string, other: string): number => {
      let s = 0;
      if (candidate.length < other.length) s += 1;
      if (countWords(candidate) < countWords(other)) s += 3; // strong signal
      if (countWords(candidate) === 1) s += 1;               // single word is very likely artist
      if (matchesChannel(candidate)) s += 4;                 // strongest signal
      if (channelIsLabel) s += 1;                             // label = trust title extraction
      return s;
    };

    const normalValid = isReasonableArtist(left) && right.length > 0;
    const reversedValid = isReasonableArtist(right) && left.length > 0;
    const leftScore = normalValid ? score(left, right) : -1;
    const rightScore = reversedValid ? score(right, left) : -1;

    if (leftScore > 0 || rightScore > 0) {
      if (leftScore > rightScore) return left;
      if (rightScore > leftScore) return right;
      // Tied — prefer right side for label channels ("Song - Artist" is common on labels),
      // left side for non-label channels ("Artist - Song" is standard elsewhere).
      return channelIsLabel ? right : left;
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
  const rawTitle = decodeHtml(title);
  const rawChannel = decodeHtml(channelTitle);

  // 1. Clean the title
  const cleanedTitle = cleanTitle(rawTitle);

  // 2. Infer the artist
  const artist = inferArtist(cleanedTitle || rawTitle, rawChannel);

  // 3. Apply artist-specific normalisation (strip Topic/VEVO/Official suffixes)
  const displayArtist = normalizeArtist(artist || "Unknown Artist");

  // 4. Build canonical forms (using ArtistNormalizer for artist-specific stripping)
  const canonicalTitleResult = canonicalString(cleanedTitle || rawTitle);
  const canonicalArtistResult = canonicalArtistStr(displayArtist);

  return {
    videoId,
    rawTitle,
    rawChannel,
    title: cleanedTitle || rawTitle,
    artist: displayArtist,
    canonicalTitle: canonicalTitleResult,
    canonicalArtist: canonicalArtistResult,
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


