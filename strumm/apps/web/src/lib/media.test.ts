import { describe, it, expect, vi } from "vitest";

// The API server egress is YouTube-CDN-blocked, so /image-proxy must never be
// used for YouTube-hosted thumbnails (they 502 -> blank art). Those load
// directly from the browser. Only non-YouTube image hosts go through the proxy.
vi.mock("web/lib/api", () => ({
  apiUrl: (p: string) => `API:${p}`,
}));

import { getOptimizedArtworkUrl, getArtworkCandidates } from "web/lib/media";

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

  it("routes non-YouTube hosts through the optimizing proxy", () => {
    const url = getOptimizedArtworkUrl("https://i.scdn.co/image/abc", 160);
    expect(url).toBe(
      "API:/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fabc&w=160&quality=80",
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
});