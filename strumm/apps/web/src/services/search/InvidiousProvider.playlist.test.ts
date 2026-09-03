import { describe, it, expect, afterEach, vi } from "vitest";
import { invidiousProvider } from "web/services/search/InvidiousProvider";

/**
 * These tests exercise getPlaylistItems against the backend proxy's Piped-
 * compatible `/playlists/{id}` response shape (tracks under `relatedStreams`).
 * The regression invariant: the browser fetches `/proxy/yt/playlist/...` and
 * NEVER a `pipedapi.*` instance directly.
 */
describe("invidiousProvider.getPlaylistItems (server proxy / Piped shape)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockProxy(body: unknown) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: body }),
    });
  }

  it("calls the backend proxy (never pipedapi.*) and parses relatedStreams", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          name: "Mix",
          videos: 2,
          relatedStreams: [
            { url: "/watch?v=aaa11111111", title: "One Dance", uploaderName: "Drake", thumbnail: "t1", duration: 175 },
            { url: "/watch?v=bbb22222222", title: "God's Plan", uploaderName: "Drake", thumbnail: "t2", duration: 198 },
          ],
          nextpage: null,
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const items = await invidiousProvider.getPlaylistItems("PLabc123");
    expect(items).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({ videoId: "aaa11111111", title: "One Dance", artist: "Drake", duration: 175 }),
      expect.objectContaining({ videoId: "bbb22222222", title: "God's Plan", artist: "Drake", duration: 198 }),
    ]);

    // Regression: no direct public Piped instance call.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(/\/yt\/playlist\/PLabc123/);
    expect(url).not.toMatch(/pipedapi\./);
  });

  it("returns [] when a playlist response carries no relatedStreams", async () => {
    mockProxy({ name: "Member-only", videos: 0, relatedStreams: [], nextpage: null });
    expect(await invidiousProvider.getPlaylistItems("PLabc123")).toEqual([]);
  });
});