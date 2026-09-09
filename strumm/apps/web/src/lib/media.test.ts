import { describe, it, expect, vi } from "vitest";

// The API server egress is YouTube-CDN-blocked, so /image-proxy must never be
// used for YouTube-hosted thumbnails (they'd 502 -> blank art). Those load
// directly from the browser. Only non-YouTube image hosts go through the proxy.
vi.mock("web/lib/api", () => ({
  apiUrl: (p: string) => `API:${p}`,
}));

import { getOptimizedArtworkUrl, getArtworkCandidates, ARTWORK_QUALITY_FULL, ARTWORK_QUALITY_LOW } from "web/lib/media";

describe("getOptimizedArtworkUrl", () => {
  it("returns YouTube-hosted URLs directly (server proxy is CDN-blocked)", () => {
    expect(getOptimizedArtworkUrl("https://i.ytimg.com/vi/abc/0.jpg", 160)).toBe(
      "https://i.ytimg.com/vi/abc/0.jpg",
    );
    expect(getOptimizedArtworkUrl("https://img.youtube.com/vi/abc/0.jpg", 160)).toBe(
      "https://img.youtube.com/vi/abc/0.jpg",
    );
    expect(
      getOptimizedArtworkUrl("https://lh3.googleusercontent.com/x=w160", 160),
    ).toBe("https://lh3.googleusercontent.com/x=w160");
  });

  it("routes non-YouTube hosts through the optimizing proxy with default quality", () => {
    const url = getOptimizedArtworkUrl("https://i.scdn.co/image/abc", 160);
    expect(url).toBe(
      "API:/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fabc&w=160&quality=75",
    );
  });

  it("uses custom quality when provided", () => {
    const url = getOptimizedArtworkUrl("https://i.scdn.co/image/abc", 384, ARTWORK_QUALITY_FULL);
    expect(url).toBe(
      "API:/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fabc&w=384&quality=95",
    );
  });

  it("returns empty string for blank input", () => {
    expect(getOptimizedArtworkUrl("", 160)).toBe("");
  });
});

describe("getArtworkCandidates", () => {
  it("does not duplicate the direct URL when the thumbnail is YouTube-hosted", () => {
    const candidates = getArtworkCandidates({
      videoId: "abc",
      thumbnail: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
    });
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg");
    expect(candidates.filter((c) => c === candidates[0]).length).toBe(1);
  });

  it("differentiates cache entries by quality", () => {
    const lowCandidates = getArtworkCandidates(
      { videoId: "xyz", thumbnail: "https://i.scdn.co/image/abc" },
      false,
      ARTWORK_QUALITY_LOW,
    );
    const fullCandidates = getArtworkCandidates(
      { videoId: "xyz", thumbnail: "https://i.scdn.co/image/abc" },
      false,
      ARTWORK_QUALITY_FULL,
    );
    // The first candidate (proxied) should differ in quality param
    expect(lowCandidates[0]).not.toBe(fullCandidates[0]);
    expect(lowCandidates[0]).toContain("quality=70");
    expect(fullCandidates[0]).toContain("quality=95");
  });
});
