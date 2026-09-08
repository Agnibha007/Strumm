import { describe, it, expect, vi, beforeEach } from "vitest";
import { invidiousProvider } from "web/services/search/InvidiousProvider";
import { fetchPipedStreams } from "web/services/search/InvidiousProvider";
import {
  secondsToMmss,
  musicItemToCandidate,
  collectSongCandidates,
  songResultToCandidate,
  finalizeCandidate,
  resolveTrackOnBrowser,
  resolveMetadataOnBrowser,
  resolveRelatedOnBrowser,
  extractPlaylistOnBrowser,
} from "web/services/search/BrowserYouTubeMusicResolver";
import { normalizeSong } from "web/services/metadata";

vi.mock("web/services/search/InvidiousProvider", () => ({
  invidiousProvider: {
    name: "Piped (fallback)",
    search: vi.fn(),
    getVideoDetails: vi.fn(),
    getPlaylistItems: vi.fn(),
  },
  fetchPipedStreams: vi.fn(),
}));

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

describe("finalizeCandidate (choke point)", () => {
  it("splits a [Artist] - [Song] title using the channel signal", () => {
    expect(finalizeCandidate("KK - Aankhon Mein Teri (Official Audio)", "KK - Topic", "KK - Topic")).toEqual({
      title: "Aankhon Mein Teri",
      artist: "KK",
      canonicalTitle: "aankhon mein teri",
      canonicalArtist: "kk",
    });
  });

  it("removes official-video clutter and unwraps a VEVO channel artist", () => {
    const final = finalizeCandidate(
      "Young, Wild and Free (Official Music Video)",
      "SnoopDoggVEVO",
      "SnoopDoggVEVO",
    );
    expect(final.title).toBe("Young, Wild and Free");
    expect(final.artist).toBe("Snoop Dogg");
    expect(final.canonicalTitle).toBe("young wild and free");
    expect(final.canonicalArtist).toBe("snoop dogg");
  });

  it("prefers structured (known) artists over the title prefix", () => {
    const final = finalizeCandidate(
      "Arijit Singh, Pritam - Ae Dil Hai Mushkil",
      "Arijit Singh, Pritam",
      undefined,
      { knownArtist: "Arijit Singh, Pritam" },
    );
    expect(final.title).toBe("Ae Dil Hai Mushkil");
    expect(final.artist).toBe("Arijit Singh, Pritam");
    expect(final.canonicalTitle).toBe("ae dil hai mushkil");
    expect(final.canonicalArtist).toBe("arijit singh pritam");
  });

  it("keeps already-normalized input byte-for-byte (idempotence guard)", () => {
    const final = finalizeCandidate(
      "Artist - Song Title (Official Video)",
      "Snoop Dogg",
      "SnoopDoggVEVO",
      { alreadyNormalized: true },
    );
    expect(final.title).toBe("Artist - Song Title (Official Video)");
    expect(final.artist).toBe("Snoop Dogg");
    expect(final.canonicalTitle).toBeTruthy();
    expect(final.canonicalArtist).toBeTruthy();
  });

  it("preserves false-positive dash titles (precision-first)", () => {
    for (const title of [
      "Love Me - Love Me",
      "One More Night - Remix",
      "Highway - A Love Story",
      "AC/DC - Thunderstruck",
    ]) {
      expect(finalizeCandidate(title, "Some Channel", "Some Channel").title).toBe(title);
    }
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
      canonicalTitle: "never gonna give you up",
      canonicalArtist: "rick astley",
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

  it("normalizes raw YT Music metadata using structured artists", () => {
    const item = {
      id: "dQw4w9WgXcQ",
      item_type: "song",
      title: "Arijit Singh, Pritam - Ae Dil Hai Mushkil (Official Music Video)",
      artists: [{ name: "Arijit Singh" }, { name: "Pritam" }],
      duration: { seconds: 240, text: "4:00" },
      thumbnail: { contents: [{ url: "https://img" }] },
    };
    const cand = musicItemToCandidate(item)!;
    expect(cand.title).toBe("Ae Dil Hai Mushkil");
    expect(cand.artist).toBe("Arijit Singh, Pritam");
    // Original structured artist names are preserved.
    expect(cand.artists).toEqual([{ name: "Arijit Singh" }, { name: "Pritam" }]);
    expect(cand.canonicalTitle).toBe("ae dil hai mushkil");
    expect(cand.canonicalArtist).toBe("arijit singh pritam");
  });

  it("yields canonicals consistent with the search-created normalizer", () => {
    const item = song("abc12345678", "KK - Aankhon Mein Teri (Official Audio)", "KK", "3:00");
    const cand = musicItemToCandidate(item)!;
    // Search produces the same result for the identical raw title/channel.
    const search = normalizeSong(
      "abc12345678",
      "KK - Aankhon Mein Teri (Official Audio)",
      "KK - Topic",
      "",
      180,
    );
    expect(cand.title).toBe(search.title);
    expect(cand.artist).toBe(search.artist);
    expect(cand.canonicalTitle).toBe(search.canonicalTitle);
    expect(cand.canonicalArtist).toBe(search.canonicalArtist);
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

describe("songResultToCandidate", () => {
  it("maps a Piped SongResult to an importer-shaped candidate", () => {
    const cand = songResultToCandidate({
      videoId: "abc12345678",
      title: "One Dance",
      artist: "Drake",
      thumbnail: "https://img/one.jpg",
      duration: 175,
    })!;
    expect(cand).toEqual({
      videoId: "abc12345678",
      title: "One Dance",
      artists: [{ name: "Drake" }],
      artist: "Drake",
      duration: "2:55",
      duration_seconds: 175,
      thumbnails: [{ url: "https://img/one.jpg" }],
      canonicalTitle: "one dance",
      canonicalArtist: "drake",
    });
  });

  it("skips invalid video ids, empty titles, and null input", () => {
    expect(
      songResultToCandidate({ videoId: "short", title: "x", artist: "a", thumbnail: "", duration: 0 }),
    ).toBeNull();
    expect(
      songResultToCandidate({ videoId: "abc12345678", title: "  ", artist: "a", thumbnail: "", duration: 10 }),
    ).toBeNull();
    expect(songResultToCandidate(null as any)).toBeNull();
  });

  it("defaults artist and omits empty thumbnails", () => {
    const cand = songResultToCandidate({
      videoId: "abc12345678",
      title: "No Artist",
      artist: "",
      thumbnail: "",
      duration: 0,
    })!;
    expect(cand.artist).toBe("Unknown Artist");
    expect(cand.artists).toEqual([]);
    expect(cand.thumbnails).toEqual([]);
    expect(cand.duration).toBe("");
  });

  it("does NOT double-normalize already-normalized search results", () => {
    // Search results have already passed through normalizeSong(); the raw
    // "Artist - Title (Official Video)" shape must survive untouched even
    // though the raw pipeline would happily split it.
    const cand = songResultToCandidate({
      videoId: "abc12345678",
      title: "Artist - Song Title (Official Video)",
      artist: "Snoop Dogg",
      thumbnail: "",
      duration: 175,
    })!;
    expect(cand.title).toBe("Artist - Song Title (Official Video)");
    expect(cand.artist).toBe("Snoop Dogg");
  });
});

describe("resolveTrackOnBrowser (Piped)", () => {
  beforeEach(() => {
    vi.mocked(invidiousProvider.search).mockReset();
  });

  it("maps Piped songs to candidates and applies the limit", async () => {
    vi.mocked(invidiousProvider.search).mockResolvedValue({
      songs: [
        { videoId: "abc12345678", title: "One Dance", artist: "Drake", thumbnail: "t1", duration: 175 },
        { videoId: "abc23456789", title: "God's Plan", artist: "Drake", thumbnail: "t2", duration: 198 },
        { videoId: "abc34567890", title: "Hotline Bling", artist: "Drake", thumbnail: "t3", duration: 267 },
      ],
      albums: [],
      artists: [],
    });

    const out = await resolveTrackOnBrowser("drake", 2);
    expect(invidiousProvider.search).toHaveBeenCalledWith("drake", "video");
    expect(out.map((c) => c.videoId)).toEqual(["abc12345678", "abc23456789"]);
  });

  it("passes already-normalized titles through unchanged", async () => {
    vi.mocked(invidiousProvider.search).mockResolvedValue({
      songs: [
        { videoId: "abc12345678", title: "One Dance", artist: "Drake", thumbnail: "t1", duration: 175 },
      ],
      albums: [],
      artists: [],
    });

    const out = await resolveTrackOnBrowser("drake");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("One Dance");
    expect(out[0].artist).toBe("Drake");
    expect(out[0].canonicalTitle).toBe("one dance");
    expect(out[0].canonicalArtist).toBe("drake");
  });

  it("skips non-11-char song ids returned by the provider", async () => {
    vi.mocked(invidiousProvider.search).mockResolvedValue({
      songs: [
        { videoId: "PL12345678901234567890", title: "Playlist-ish", artist: "X", thumbnail: "", duration: 0 },
        { videoId: "abc12345678", title: "Real Song", artist: "Y", thumbnail: "t", duration: 90 },
      ],
      albums: [],
      artists: [],
    });

    const out = await resolveTrackOnBrowser("q");
    expect(out.map((c) => c.videoId)).toEqual(["abc12345678"]);
  });

  it("returns empty on a provider error (caller falls back to server)", async () => {
    vi.mocked(invidiousProvider.search).mockRejectedValue(new Error("fetch failed"));
    expect(await resolveTrackOnBrowser("drake")).toEqual([]);
  });

  it("returns empty for blank queries without calling the provider", async () => {
    expect(await resolveTrackOnBrowser("  ")).toEqual([]);
    expect(invidiousProvider.search).not.toHaveBeenCalled();
  });
});

describe("browser-side metadata & related (Piped /streams)", () => {
  beforeEach(() => {
    vi.mocked(fetchPipedStreams).mockReset();
  });

  it("resolveMetadataOnBrowser maps the stream info to a Song", async () => {
    vi.mocked(fetchPipedStreams).mockResolvedValue({
      title: "One Dance",
      uploader: "Drake",
      thumbnailUrl: "https://thumbs.example/1.jpg",
      duration: 175,
    });
    const meta = await resolveMetadataOnBrowser("abc12345678");
    expect(meta).toEqual({
      videoId: "abc12345678",
      title: "One Dance",
      artist: "Drake",
      thumbnail: "https://thumbs.example/1.jpg",
      duration: 175,
    });
  });

  it("resolveMetadataOnBrowser normalizes raw Piped metadata", async () => {
    vi.mocked(fetchPipedStreams).mockResolvedValue({
      title: "Young, Wild and Free (Official Music Video)",
      uploader: "SnoopDoggVEVO",
      thumbnailUrl: "https://thumbs.example/1.jpg",
      duration: 190,
    });
    const meta = await resolveMetadataOnBrowser("abc12345678");
    expect(meta!.title).toBe("Young, Wild and Free");
    expect(meta!.artist).toBe("Snoop Dogg");
  });

  it("resolveMetadataOnBrowser returns null for invalid id / missing data", async () => {
    expect(await resolveMetadataOnBrowser("")).toBeNull();
    expect(await resolveMetadataOnBrowser(null as unknown as string)).toBeNull();
  });

  it("resolveMetadataOnBrowser returns null when Piped fails", async () => {
    vi.mocked(fetchPipedStreams).mockRejectedValue(new TypeError("fetch failed"));
    expect(await resolveMetadataOnBrowser("abc12345678")).toBeNull();
  });

  it("resolveRelatedOnBrowser maps related streams to Songs and drops excluded ids", async () => {
    vi.mocked(fetchPipedStreams).mockResolvedValue({
      title: "Seed",
      relatedStreams: [
        { url: "/watch?v=aaa11111111", type: "stream", title: "A", uploaderName: "Art1", duration: 100 },
        { url: "/watch?v=bbb22222222", type: "stream", title: "B", uploaderName: "Art2", duration: 200 },
        { url: "/watch?v=aaa11111111", type: "stream", title: "A dup", uploaderName: "Art1", duration: 100 },
        { url: "/channel/UCxxxx", type: "channel", title: "Channel", uploaderName: "Art", duration: 0 },
        { url: "/watch?v=ccc33333333", type: "stream", title: "Excluded", uploaderName: "Art3", duration: 300 },
      ],
    });
    const songs = await resolveRelatedOnBrowser("abc12345678", ["ccc33333333"]);
    expect(songs.map((s) => s.videoId)).toEqual(["aaa11111111", "bbb22222222"]);
    expect(songs[0].artist).toBe("Art1");
  });

  it("resolveRelatedOnBrowser normalizes radio titles and unwraps VEVO channels", async () => {
    vi.mocked(fetchPipedStreams).mockResolvedValue({
      title: "Seed",
      relatedStreams: [
        { url: "/watch?v=abc11112222", type: "stream", title: "Young, Wild and Free (Official Music Video)", uploaderName: "SnoopDoggVEVO", duration: 190 },
        { url: "/watch?v=abc33334444", type: "stream", title: "KK - Aankhon Mein Teri (Official Audio)", uploaderName: "KK - Topic", duration: 180 },
      ],
    });
    const songs = await resolveRelatedOnBrowser("abc12345678");
    expect(songs).toHaveLength(2);
    expect(songs[0]).toMatchObject({ videoId: "abc11112222", title: "Young, Wild and Free", artist: "Snoop Dogg" });
    expect(songs[1]).toMatchObject({ videoId: "abc33334444", title: "Aankhon Mein Teri", artist: "KK" });
    // Consistent with what search (normalizeSong) would produce for the same raw fields.
    const search = normalizeSong("abc11112222", "Young, Wild and Free (Official Music Video)", "SnoopDoggVEVO", "", 190);
    expect(songs[0].title).toBe(search.title);
    expect(songs[0].artist).toBe(search.artist);
  });

  it("resolveRelatedOnBrowser returns [] when Piped fails", async () => {
    vi.mocked(fetchPipedStreams).mockRejectedValue(new TypeError("fetch failed"));
    expect(await resolveRelatedOnBrowser("abc12345678")).toEqual([]);
  });
});

describe("extractPlaylistOnBrowser (Piped /playlists)", () => {
  beforeEach(() => {
    vi.mocked(invidiousProvider.getPlaylistItems).mockReset();
  });

  it("extracts importer rows from a YouTube URL", async () => {
    vi.mocked(invidiousProvider.getPlaylistItems).mockResolvedValue([
      { videoId: "aaa11111111", title: "One Dance", artist: "Drake", thumbnail: "", duration: 175 },
      { videoId: "bbb22222222", title: "God's Plan", artist: "Drake", thumbnail: "", duration: 198 },
    ]);
    const rows = await extractPlaylistOnBrowser("https://music.youtube.com/playlist?list=PLabc123");
    expect(invidiousProvider.getPlaylistItems).toHaveBeenCalledWith("PLabc123");
    expect(rows).toEqual([
      { title: "One Dance", artist: "Drake", album: "", duration: 175, thumbnail: "", videoId: "aaa11111111" },
      { title: "God's Plan", artist: "Drake", album: "", duration: 198, thumbnail: "", videoId: "bbb22222222" },
    ]);
  });

  it("returns [] for a non-YouTube URL or missing list id", async () => {
    expect(await extractPlaylistOnBrowser("https://open.spotify.com/playlist/xyz")).toEqual([]);
    expect(await extractPlaylistOnBrowser("https://youtube.com/watch?v=abc12345678")).toEqual([]);
    expect(invidiousProvider.getPlaylistItems).not.toHaveBeenCalled();
  });

  it("drops non-canonical videoIds and returns [] when none survive", async () => {
    vi.mocked(invidiousProvider.getPlaylistItems).mockResolvedValue([
      { videoId: "MPREb_malformedid", title: "Album", artist: "A", thumbnail: "", duration: 100 },
    ]);
    expect(await extractPlaylistOnBrowser("https://youtube.com/playlist?list=PLabc123")).toEqual([]);
  });

  it("returns [] when Piped fails", async () => {
    vi.mocked(invidiousProvider.getPlaylistItems).mockRejectedValue(new TypeError("fetch failed"));
    expect(await extractPlaylistOnBrowser("https://youtube.com/playlist?list=PLabc123")).toEqual([]);
  });
});