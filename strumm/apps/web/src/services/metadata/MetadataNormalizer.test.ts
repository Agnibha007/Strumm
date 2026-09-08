import { describe, it, expect } from "vitest";
import {
  normalizeSong,
  extractArtistPrefix,
  cleanTitle,
} from "./MetadataNormalizer";
import { canonicalSongKey } from "./canonical";

/**
 * Regression suite for the Metadata Normalization Pipeline, with a focus on
 * the high-precision "[Artist] - [Song]" extraction stage.
 *
 * Categories:
 *   A. Clear artist-prefix cases that MUST split
 *   B. Existing clutter-cleanup behavior (must be preserved)
 *   C. False-positive protection (must NOT split)
 *   D. Metadata-assisted cases (channel / knownArtist raise confidence)
 *   E. Idempotence (normalizing twice == once)
 */

function run(title: string, channel = "YouTube", extra: Partial<Record<"knownArtist", string>> = {}) {
  return normalizeSong("dQw4w9WgXcQ", title, channel, "", 0, extra.knownArtist);
}

// ---------------------------------------------------------------------------
// A. Clear artist-prefix cases
// ---------------------------------------------------------------------------

describe("artist-prefix extraction (positive)", () => {
  it("splits a comma-separated collaboration", () => {
    const s = run("Arijit Singh, Pritam - Ae Dil Hai Mushkil");
    expect(s.title).toBe("Ae Dil Hai Mushkil");
    expect(s.artist).toBe("Arijit Singh, Pritam");
  });

  it("splits a single short artist name", () => {
    const s = run("KK - Aankhon Mein Teri");
    expect(s.title).toBe("Aankhon Mein Teri");
    expect(s.artist).toBe("KK");
  });

  it("splits a multi-word artist phrase", () => {
    const s = run("Pritam - Phir Le Aaya Dil");
    expect(s.title).toBe("Phir Le Aaya Dil");
    expect(s.artist).toBe("Pritam");
  });

  it("splits an ampersand collaboration with a single-word song", () => {
    const s = run("Arijit Singh & Shreya Ghoshal - Samjhawan");
    expect(s.title).toBe("Samjhawan");
    expect(s.artist).toBe("Arijit Singh & Shreya Ghoshal");
  });

  it("splits after generic clutter cleanup", () => {
    const s = run("Atif Aslam - Tera Hone Laga Hoon (Official Audio)");
    expect(s.title).toBe("Tera Hone Laga Hoon");
    expect(s.artist).toBe("Atif Aslam");
  });

  it("splits a comma collaboration with a single-word song", () => {
    const s = run("Vishal Dadlani, Shekhar Ravjiani - Zinda");
    expect(s.title).toBe("Zinda");
    expect(s.artist).toBe("Vishal Dadlani, Shekhar Ravjiani");
  });

  it("splits a plain two-word artist", () => {
    const s = run("The Weeknd - Blinding Lights");
    expect(s.title).toBe("Blinding Lights");
    expect(s.artist).toBe("The Weeknd");
  });

  it("splits a multi-word artist phrase on a Topic channel", () => {
    // Interior lowercase connectors ("of a") make the left side a proper-noun
    // phrase; on a generic channel we stay conservative, but the Topic channel
    // backs it up and the split proceeds.
    const s = run("System of a Down - Chop Suey!", "System of a Down - Topic");
    expect(s.title).toBe("Chop Suey!");
    expect(s.artist).toBe("System of a Down");
  });

  it("keeps a conservative left-side at low confidence intact", () => {
    const s = run("System of a Down - Chop Suey!", "YouTube");
    expect(s.title).toBe("System of a Down - Chop Suey!");
  });

  it("cleans a trailing clutter suffix before splitting", () => {
    // Generic cleanup runs FIRST, so "… - Official Video" is stripped and the
    // remaining clean pair is a normal artist/song split.
    const s = run("Arijit Singh - Tera Hone Laga Hoon - Official Video");
    expect(s.title).toBe("Tera Hone Laga Hoon");
    expect(s.artist).toBe("Arijit Singh");
  });

  it("preserves the raw title on the normalized song", () => {
    const s = run("Arijit Singh, Pritam - Ae Dil Hai Mushkil");
    expect(s.rawTitle).toBe("Arijit Singh, Pritam - Ae Dil Hai Mushkil");
  });

  it("keeps canonical fields consistent with the split", () => {
    const s = run("Arijit Singh, Pritam - Ae Dil Hai Mushkil");
    expect(s.canonicalTitle).toBe("ae dil hai mushkil");
    expect(s.canonicalArtist).toBe("arijit singh pritam");
    // Dedup still keys on the canonical pair of the cleaned fields.
    expect(canonicalSongKey(s.title, s.artist)).toBe(
      `${s.canonicalTitle}|${s.canonicalArtist}`,
    );
  });
});

// ---------------------------------------------------------------------------
// B. Existing cleanup behavior (must not regress)
// ---------------------------------------------------------------------------

describe("existing clutter cleanup", () => {
  const cases: Array<[string, string]> = [
    ["one night (Lyrics)", "one night"],
    ["Aankhon Mein Teri (Official Video) HD 🔥", "Aankhon Mein Teri"],
    ["Samjhawan (Official Audio)", "Samjhawan"],
    ["Tera Hone Laga Hoon | Lyrics", "Tera Hone Laga Hoon"],
    ["Phir Le Aaya Dil [Official Music Video] 4K", "Phir Le Aaya Dil"],
    ["Love Story (Full Song)", "Love Story"],
    ["Dil Dhadakne Do - Official Music Video", "Dil Dhadakne Do"],
  ];

  for (const [input, expected] of cases) {
    it(`cleans ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const s = run(input);
      expect(s.title).toBe(expected);
      expect(s.rawTitle).toBe(input);
    });
  }
});

// ---------------------------------------------------------------------------
// C. False-positive protection (must NOT split)
// ---------------------------------------------------------------------------

describe("false-positive protection", () => {
  const keepTitles: Array<[string, string]> = [
    // Mirror halves are one title, not an artist pair.
    ["Love Me - Love Me", "Love Me - Love Me"],
    // Right side is a version descriptor.
    ["One More Night - Remix", "One More Night - Remix"],
    // Right side is a subtitle ("A Love Story"), left is not an artist.
    ["Highway - A Love Story", "Highway - A Love Story"],
    // Slash-heavy band name is not a confident artist prefix.
    ["AC/DC - Thunderstruck", "AC/DC - Thunderstruck"],
    // Multiple separators must not collapse to the last segment.
    ["Artist - Song - Remix", "Artist - Song - Remix"],
    ["Arijit Singh - Tera Hone Laga Hoon - Remix", "Arijit Singh - Tera Hone Laga Hoon - Remix"],
  ];

  for (const [input, expectedTitle] of keepTitles) {
    it(`leaves ${JSON.stringify(input)} intact`, () => {
      const s = run(input);
      expect(s.title).toBe(expectedTitle);
    });
  }

  it("never picks the song side as the artist", () => {
    // Regression: the old scorer picked "Samjhawan" / "Zinda" as the artist.
    const collab = run("Arijit Singh & Shreya Ghoshal - Samjhawan");
    expect(collab.artist).not.toBe("Samjhawan");
    const zinda = run("Vishal Dadlani, Shekhar Ravjiani - Zinda");
    expect(zinda.artist).not.toBe("Zinda");
  });

  it("leaves single-word/single-word splits alone", () => {
    const s = run("Hello - World");
    expect(s.title).toBe("Hello - World");
  });

  it("leaves artist-style punctuation that is not name-like alone", () => {
    const s = run("P!NK - Raise Your Glass");
    expect(s.title).toBe("P!NK - Raise Your Glass");
  });

  it("leaves a lone-clutter left side alone", () => {
    const s = run("Official - Tera Hone Laga Hoon");
    expect(s.title).toBe("Official - Tera Hone Laga Hoon");
  });

  it("does not split an em-dash or bare hyphen without spaces", () => {
    const a = run("Sia—Unstoppable");
    expect(a.title).toBe("Sia—Unstoppable");
    const b = run("Heart-Shaped Box");
    expect(b.title).toBe("Heart-Shaped Box");
  });

  it("extractArtistPrefix returns null for non-splits", () => {
    expect(extractArtistPrefix("One More Night - Remix")).toBeNull();
    expect(extractArtistPrefix("AC/DC - Thunderstruck")).toBeNull();
    expect(extractArtistPrefix("Highway - A Love Story")).toBeNull();
    expect(extractArtistPrefix("Love Me - Love Me")).toBeNull();
    expect(extractArtistPrefix("Artist - Song - Remix")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D. Metadata-assisted cases
// ---------------------------------------------------------------------------

describe("metadata-assisted extraction", () => {
  it("channel agreement (Topic) raises confidence", () => {
    const s = run("KK - Aankhon Mein Teri", "KK - Topic");
    expect(s.artist).toBe("KK");
    expect(s.title).toBe("Aankhon Mein Teri");
  });

  it("channel agreement (plain artist channel) raises confidence", () => {
    const s = run("Atif Aslam - Tera Hone Laga Hoon", "Atif Aslam");
    expect(s.artist).toBe("Atif Aslam");
    expect(s.title).toBe("Tera Hone Laga Hoon");
  });

  it("knownArtist metadata forces a split that would otherwise be rejected", () => {
    // A 5-letter all-caps run ("BNCCC") is not name-like, so without metadata
    // the extractor stays conservative; YT Music-style known-artist metadata
    // backs it up and the split proceeds.
    const plain = run("BNCCC - Some Monsoon Song", "YouTube");
    expect(plain.title).toBe("BNCCC - Some Monsoon Song");

    const assisted = run("BNCCC - Some Monsoon Song", "YouTube", { knownArtist: "BNCCC" });
    expect(assisted.artist).toBe("BNCCC");
    expect(assisted.title).toBe("Some Monsoon Song");
  });

  it("knownArtist agreement does not override an implausible right side", () => {
    const s = run("KK - Remix", "KK - Topic", { knownArtist: "KK" });
    expect(s.title).toBe("KK - Remix");
  });
});

// ---------------------------------------------------------------------------
// E. Idempotence
// ---------------------------------------------------------------------------

describe("idempotence", () => {
  it("splitting twice yields the same result as splitting once", () => {
    const once = run("Arijit Singh, Pritam - Ae Dil Hai Mushkil");
    // A second pass on the already-split title is a no-op: carrying the split
    // artist forward keeps both fields stable.
    const twice = run(once.title, once.artist);
    expect(twice.title).toBe("Ae Dil Hai Mushkil");
    expect(twice.artist).toBe("Arijit Singh, Pritam");
  });

  it("rejected titles stay rejected and stable", () => {
    const once = run("One More Night - Remix");
    const twice = run(once.title, "YouTube");
    expect(twice.title).toBe("One More Night - Remix");
    expect(once.artist).toBe(twice.artist);
  });

  it("cleanTitle is stable", () => {
    const raw = "Aankhon Mein Teri (Official Video) HD 🔥";
    const a = cleanTitle(raw);
    const b = cleanTitle(a);
    expect(b).toBe(a);
  });
});