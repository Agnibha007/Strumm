import { describe, it, expect } from "vitest";
import {
  secondsToMmss,
  musicItemToCandidate,
  collectSongCandidates,
} from "web/services/search/BrowserYouTubeMusicResolver";

function song(id: string, title: string, artist: string, mmss = "3:00") {
  const parts = mmss.split(":").map(Number);
  return {
    id,
    item_type: "song",
    title,
    artists: [{ name: artist }],
    duration: { seconds: parts[0] * 60 + parts[1], text: mmss },
    thumbnail: { contents: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
  };
}

describe("secondsToMmss", () => {
  it("formats minutes:seconds", () => {
    expect(secondsToMmss(245)).toBe("4:05");
  });

  it("formats hours when long", () => {
    expect(secondsToMmss(3661)).toBe("1:01:01");
  });

  it("handles zero and negative input", () => {
    expect(secondsToMmss(0)).toBe("");
    expect(secondsToMmss(-5)).toBe("");
  });
});

describe("musicItemToCandidate", () => {
  it("maps a song node to importer-shaped candidate", () => {
    const item = {
      id: "dQw4w9WgXcQ",
      item_type: "song",
      title: "Never Gonna Give You Up",
      artists: [{ name: "Rick Astley" }],
      duration: { seconds: 213, text: "3:33" },
      thumbnail: { contents: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }] },
    };
    expect(musicItemToCandidate(item)).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      artists: [{ name: "Rick Astley" }],
      artist: "Rick Astley",
      duration: "3:33",
      duration_seconds: 213,
      thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }],
    });
  });

  it("supports numeric durations and a plain author fallback", () => {
    const item = {
      id: "ab_cDeFgHiJ",
      item_type: "video",
      title: "Some Song",
      author: { name: "Some Artist " },
      duration: 120,
      thumbnail: { contents: [{ url: "http://thumb" }] },
    };
    const cand = musicItemToCandidate(item)!;
    expect(cand.artist).toBe("Some Artist");
    expect(cand.duration_seconds).toBe(120);
    expect(cand.duration).toBe("2:00");
    expect(cand.thumbnails).toEqual([{ url: "http://thumb" }]);
  });

  it("skips album/artist nodes and nodes without a video id", () => {
    expect(musicItemToCandidate({ id: "MPREF1234567", item_type: "song", title: "X" })).toBeNull();
    expect(musicItemToCandidate({ id: "MPREbXyZ9abc", item_type: "album", title: "Album" })).toBeNull();
    expect(musicItemToCandidate({ id: "PL129", item_type: "playlist", title: "Playlist" })).toBeNull();
    // Non-11-char ids are never usable as song video ids.
    expect(musicItemToCandidate({ id: "short", item_type: "song", title: "X" })).toBeNull();
    expect(musicItemToCandidate({ item_type: "song", title: "NoId" })).toBeNull();
  });

  it("returns null for empty title", () => {
    expect(musicItemToCandidate({ id: "dQw4w9WgXcQ", item_type: "song", title: "  " })).toBeNull();
  });

  it("joins multiple artists with a comma", () => {
    const item = {
      id: "dQw4w9WgXcQ",
      item_type: "song",
      title: "Hymn",
      artists: [{ name: "A" }, { name: "B" }],
      duration: { seconds: 61, text: "1:01" },
    };
    expect(musicItemToCandidate(item)!.artist).toBe("A, B");
  });

  it("normalizes candidate metadata from raw node fields", () => {
    const item = {
      id: "dQw4w9WgXcQ",
      item_type: "video",
      title: "Never Gonna Give You Up ",
      artists: [{ name: "Rick Astley" }],
      duration: { seconds: 213, text: "3:33" },
      thumbnail: {
        contents: [
          { url: "https://i.ytimg.com/vi/x/hq1.jpg" },
          { url: "https://i.ytimg.com/vi/x/hqdefault.jpg" },
        ],
      },
    };
    const cand = musicItemToCandidate(item)!;
    expect(cand.title).toBe("Never Gonna Give You Up"); // trimmed
    expect(cand.duration).toBe("3:33");
    expect(cand.duration_seconds).toBe(213);
    // Largest (last) thumbnail is preferred.
    expect(cand.thumbnails).toEqual([{ url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }]);
  });
});

describe("collectSongCandidates", () => {
  it("walks a MusicShelf (shelf.contents) of song nodes", () => {
    const shelf = {
      type: "MusicShelf",
      contents: [song("dQw4w9WgXcQ", "Song A", "Artist A"), song("abcdefghijk", "Song B", "Artist B")],
    };
    const out = collectSongCandidates([shelf]);
    expect(out.map((c) => c.videoId)).toEqual(["dQw4w9WgXcQ", "abcdefghijk"]);
    expect(out[0].artist).toBe("Artist A");
  });

  it("walks nested ItemSection > MusicShelf structures", () => {
    const section = {
      type: "ItemSection",
      contents: [
        {
          type: "MusicShelf",
          contents: [song("dQw4w9WgXcQ", "Deep Song", "Deep Artist")],
        },
      ],
    };
    const out = collectSongCandidates([section]);
    expect(out).toHaveLength(1);
    expect(out[0].videoId).toBe("dQw4w9WgXcQ");
  });

  it("rejects playlist / album / artist ids even inside shelves", () => {
    const shelf = {
      contents: [
        song("dQw4w9WgXcQ", "Good Song", "Artist"),
        { id: "PL12345678901234567890", item_type: "playlist", title: "Playlist" },
        { id: "MPREbXyZ9abcXY", item_type: "album", title: "Album" },
        { id: "UC12345678901234567", item_type: "artist", title: "Artist" },
      ],
    };
    const out = collectSongCandidates([shelf]);
    expect(out.map((c) => c.videoId)).toEqual(["dQw4w9WgXcQ"]);
  });

  it("keeps duplicates (dedup is the API's job downstream)", () => {
    const shelf = {
      contents: [song("dQw4w9WgXcQ", "Song A", "Artist A"), song("dQw4w9WgXcQ", "Song A", "Artist A")],
    };
    const out = collectSongCandidates([shelf]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.videoId))).toEqual(new Set(["dQw4w9WgXcQ"]));
  });

  it("returns empty for empty / wrapper-only search trees", () => {
    expect(collectSongCandidates([])).toEqual([]);
    expect(collectSongCandidates([{ contents: [] }])).toEqual([]);
    expect(collectSongCandidates([{ contents: [{ contents: [] }] }])).toEqual([]);
    expect(collectSongCandidates([{ id: "PL12345678901234567890", item_type: "playlist" }])).toEqual([]);
  });

  it("skips malformed nodes (missing id, missing title, non-dicts) without crashing", () => {
    const shelf = {
      contents: [
        null,
        "garbage",
        { item_type: "song", title: "No ID" },
        { id: "dQw4w9WgXcQ", item_type: "song", title: "  " },
        { id: "abcdefghijk", item_type: "song", title: "Valid Song" },
        { contents: [song("qrstuvwxyza", "Nested", "NArtist")] },
      ],
    };
    const out = collectSongCandidates([shelf]);
    expect(out.map((c) => c.videoId)).toEqual(["abcdefghijk", "qrstuvwxyza"]);
  });

  it("enforces the result limit across nested shelves", () => {
    const shelfA = { contents: [song("aaaaaaaaaaa", "A", "X"), song("bbbbbbbbbbb", "B", "X")] };
    const shelfB = { contents: [song("ccccccccccc", "C", "X"), song("ddddddddddd", "D", "X")] };
    expect(collectSongCandidates([shelfA, shelfB], 3).map((c) => c.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
    ]);
  });
});