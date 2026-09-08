/**
 * Metadata Normalization Pipeline — barrel exports.
 */
export { normalizeSong, normalizeSongs, cleanTitle, inferArtist, extractArtistPrefix } from "./MetadataNormalizer";
export { canonicalString, canonicalSongKey } from "./canonical";
export { normalizeArtist, canonicalArtist, areSameArtist } from "./ArtistNormalizer";
export type { NormalizedSong } from "./types";
