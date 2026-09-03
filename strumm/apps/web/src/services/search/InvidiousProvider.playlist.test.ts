import { describe, it, expect, afterEach, vi } from "vitest";
import { invidiousProvider, refreshInstances } from "web/services/search/InvidiousProvider";

/**
 * These tests exercise the REAL InvidiousProvider.getPlaylistItems against
 * Piped's documented `/playlists/{id}` response shape. The crucial invariant:
 * Piped returns the actual track list under `relatedStreams`, while `videos`
 * is only an integer COUNT. Reading `videos` as an array is a silent failure
 * (empty results), which these tests pin against.
 */
describe("invidiousProvider.getPlaylistItems (real Piped response shape)", () => {
  const originalFetch = global.fetch;
  const INSTANCE_LIST = "https://piped-instances.kavin.rocks/";

  afterEach(() => {
    global.fetch = originalFetch;
    refreshInstances();
  });

  function mockFetch(
    handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> },
  ) {
    global.fetch = vi.fn().mockImplementation((url: unknown) => {
      const asStr = String(url);
      if (asStr === INSTANCE_LIST) {
        // Force fallback to the hardcoded browser-safe instance so the
        // playlist call below goes to api.piped.private.coffee.
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      return Promise.resolve(handler(asStr));
    });
  }

  it("parses tracks from `relatedStreams` (not the `videos` integer count)", async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: "Mix",
        videos: 2,
        relatedStreams: [
          { url: "/watch?v=aaa11111111", title: "One Dance", uploaderName: "Drake", thumbnail: "t1", duration: 175 },
          { url: "/watch?v=bbb22222222", title: "God's Plan", uploaderName: "Drake", thumbnail: "t2", duration: 198 },
        ],
        nextpage: null,
      }),
    }));

    const items = await invidiousProvider.getPlaylistItems("PLabc123");
    expect(items).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({ videoId: "aaa11111111", title: "One Dance", artist: "Drake", duration: 175 }),
      expect.objectContaining({ videoId: "bbb22222222", title: "God's Plan", artist: "Drake", duration: 198 }),
    ]);
  });

  it("returns [] when a playlist response carries no relatedStreams", async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ name: "Member-only", videos: 0, relatedStreams: [], nextpage: null }),
    }));
    expect(await invidiousProvider.getPlaylistItems("PLabc123")).toEqual([]);
  });

  it("paginates via /nextpage/playlists until nextpage is absent", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(String(url));
      const isNext = String(url).includes("/nextpage/");
      if (isNext) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            relatedStreams: [
              { url: "/watch?v=ccc33333333", title: "Third", uploaderName: "X", thumbnail: "", duration: 90 },
            ],
            nextpage: null,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          relatedStreams: [
            { url: "/watch?v=aaa11111111", title: "One", uploaderName: "A", thumbnail: "", duration: 10 },
          ],
          nextpage: "TOKEN",
        }),
      };
    });

    const items = await invidiousProvider.getPlaylistItems("PLabc123");
    expect(items.map((i) => i.videoId)).toEqual(["aaa11111111", "ccc33333333"]);
    expect(calls.some((c) => c.includes("/nextpage/playlists/PLabc123?nextpage="))).toBe(true);
  });
});