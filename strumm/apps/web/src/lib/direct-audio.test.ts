import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCachedDirectAudioUrl,
  resolveDirectAudioUrl,
  clearDirectAudioCache,
} from "web/lib/direct-audio";
import { apiUrl } from "web/lib/api";

const streamsMock = vi.fn();
vi.mock("web/services/search/InvidiousProvider", () => ({
  fetchPipedStreams: (...args: unknown[]) => streamsMock(...args),
}));

function okJson(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function notFound() {
  return Promise.resolve({
    ok: false,
  } as Response);
}

const VIDEO = "abc123";
const PIPED_URL = "https://proxy.piped.example/videoplayback?itag=18";

function pipedPayload(opts: { audio?: string; combined?: string[] } = {}) {
  return {
    audioStreams: opts.audio ? [{ url: opts.audio, mimeType: "audio/mp4", bitrate: 128 }] : [],
    videoStreams:
      opts.combined?.map((url) => ({ url, mimeType: "video/mp4", videoOnly: false })) ?? [],
  };
}

describe("resolveDirectAudioUrl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearDirectAudioCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    streamsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for an empty video id", async () => {
    expect(await resolveDirectAudioUrl("")).toBeNull();
    expect(streamsMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves audio from the BROWSER via Piped and caches it", async () => {
    streamsMock.mockResolvedValue(pipedPayload({ combined: [PIPED_URL] }));

    const url = await resolveDirectAudioUrl(VIDEO);
    expect(url).toBe(PIPED_URL);
    expect(getCachedDirectAudioUrl(VIDEO)).toBe(url);
    // No server call at all — the browser hit Piped directly.
    expect(streamsMock).toHaveBeenCalledWith(VIDEO);
    expect(fetchMock).not.toHaveBeenCalled();

    // Second call hits the memo cache — no extra request.
    expect(await resolveDirectAudioUrl(VIDEO)).toBe(url);
    expect(streamsMock).toHaveBeenCalledTimes(1);
  });

  it("prefers an audio-only stream over a combined one", async () => {
    streamsMock.mockResolvedValue(pipedPayload({ audio: "https://example/audio.m4a", combined: [PIPED_URL] }));
    expect(await resolveDirectAudioUrl(VIDEO)).toBe("https://example/audio.m4a");
  });

  it("falls back to the server /play endpoint when Piped returns nothing", async () => {
    streamsMock.mockResolvedValue(null);
    fetchMock.mockReturnValueOnce(
      okJson({ success: true, data: { videoId: VIDEO, audioUrl: "https://googlevideo.example/a.m4a" } }),
    );

    const url = await resolveDirectAudioUrl(VIDEO);
    expect(url).toBe("https://googlevideo.example/a.m4a");
    expect(fetchMock.mock.calls[0][0]).toBe(apiUrl(`/play/${VIDEO}`));
    expect(getCachedDirectAudioUrl(VIDEO)).toBe(url);
  });

  it("falls back to the server when Piped has no playable stream", async () => {
    streamsMock.mockResolvedValue({ audioStreams: [], videoStreams: [] });
    fetchMock.mockReturnValueOnce(
      okJson({ success: true, data: { videoId: VIDEO, audioUrl: "https://googlevideo.example/a.m4a" } }),
    );
    expect(await resolveDirectAudioUrl(VIDEO)).toBe("https://googlevideo.example/a.m4a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent resolutions of the same video id", async () => {
    streamsMock.mockResolvedValue(pipedPayload({ combined: [PIPED_URL] }));
    const [a, b] = await Promise.all([
      resolveDirectAudioUrl(VIDEO),
      resolveDirectAudioUrl(VIDEO),
    ]);
    expect(a).toBe(PIPED_URL);
    expect(b).toBe(a);
    expect(streamsMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when both Piped and server report nothing", async () => {
    streamsMock.mockResolvedValue({ audioStreams: [], videoStreams: [] });
    fetchMock.mockReturnValueOnce(okJson({ success: false, error: "unavailable" }));
    expect(await resolveDirectAudioUrl(VIDEO)).toBeNull();
  });

  it("returns null on server HTTP error fallback", async () => {
    streamsMock.mockResolvedValue(null);
    fetchMock.mockReturnValueOnce(notFound());
    expect(await resolveDirectAudioUrl(VIDEO)).toBeNull();
  });

  it("returns null when Piped throws and the server is unreachable", async () => {
    streamsMock.mockRejectedValue(new TypeError("Failed to fetch"));
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await resolveDirectAudioUrl(VIDEO)).toBeNull();
  });

  it("negative-caches a failed resolution so it doesn't re-probe every source", async () => {
    // Both sources fail -> null, and the videoId is remembered as blocked.
    streamsMock.mockResolvedValue({ audioStreams: [], videoStreams: [] });
    fetchMock.mockReturnValueOnce(okJson({ success: false, error: "unavailable" }));
    expect(await resolveDirectAudioUrl(VIDEO)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Immediate re-request returns null WITHOUT re-probing (negative cache).
    expect(await resolveDirectAudioUrl(VIDEO)).toBeNull();
    expect(streamsMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});