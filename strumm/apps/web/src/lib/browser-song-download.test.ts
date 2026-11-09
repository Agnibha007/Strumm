import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSongInBrowser } from "./browser-song-download";

const authFetchMock = vi.fn();

vi.mock("web/lib/auth-client", () => ({ authFetch: (...args: unknown[]) => authFetchMock(...args) }));
vi.mock("web/lib/api", () => ({ apiUrl: (path: string) => `/proxy${path}` }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadSongInBrowser", () => {
  it("resolves a stream and saves the audio bytes into browser storage", async () => {
    authFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { audioStreams: [{ url: "https://r1.googlevideo.com/videoplayback?id=track", mimeType: "audio/mp4", bitrate: 128000 }] },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "audio/mp4", "content-length": "5" },
      }));

    const progress = vi.fn();
    const result = await downloadSongInBrowser(
      { videoId: "abcdefghijk", title: "Test Song" },
      new AbortController().signal,
      progress,
    );

    expect(authFetchMock).toHaveBeenNthCalledWith(1, "/proxy/yt/streams/abcdefghijk", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(authFetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("/proxy/audio-proxy?url="), expect.objectContaining({ method: "GET" }));
    expect(result.mimeType).toBe("audio/mp4");
    expect(result.blob.size).toBe(5);
    expect(result.sourceProvider).toBe("direct");
    expect(progress).toHaveBeenCalledWith(100);
  });

  it("falls back to the direct audio resolver when stream metadata has no audio", async () => {
    authFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { audioStreams: [], videoStreams: [] } }), {
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { audioUrl: "https://r1.googlevideo.com/videoplayback?id=track", mimeType: "audio/mp4" },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mp4", "content-length": "3" },
      }));

    const result = await downloadSongInBrowser(
      { videoId: "abcdefghijk", title: "Test Song" },
      new AbortController().signal,
      vi.fn(),
    );

    expect(authFetchMock).toHaveBeenNthCalledWith(2, "/proxy/play/abcdefghijk", expect.any(Object));
    expect(result.blob.size).toBe(3);
  });

  it("rejects invalid video IDs before making requests", async () => {
    await expect(downloadSongInBrowser(
      { videoId: "not-valid", title: "Test Song" },
      new AbortController().signal,
      vi.fn(),
    )).rejects.toThrow("valid YouTube video ID");
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
