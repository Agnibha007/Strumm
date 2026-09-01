import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCachedDirectAudioUrl,
  resolveDirectAudioUrl,
  clearDirectAudioCache,
} from "web/lib/direct-audio";
import { apiUrl } from "web/lib/api";

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

describe("resolveDirectAudioUrl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearDirectAudioCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for an empty video id", async () => {
    expect(await resolveDirectAudioUrl("")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the /play endpoint and caches the resolved URL", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ success: true, data: { videoId: "abc123", audioUrl: "https://googlevideo.example/a.m4a" } }),
    );

    const url = await resolveDirectAudioUrl("abc123");
    expect(url).toBe("https://googlevideo.example/a.m4a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(apiUrl("/play/abc123"));
    expect(getCachedDirectAudioUrl("abc123")).toBe(url);

    // Second call hits the memo cache — no extra request.
    expect(await resolveDirectAudioUrl("abc123")).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent resolutions of the same video id", async () => {
    fetchMock.mockReturnValue(
      okJson({ success: true, data: { videoId: "abc123", audioUrl: "https://googlevideo.example/a.m4a" } }),
    );

    const [a, b] = await Promise.all([
      resolveDirectAudioUrl("abc123"),
      resolveDirectAudioUrl("abc123"),
    ]);
    expect(a).toBe("https://googlevideo.example/a.m4a");
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the backend reports no direct audio", async () => {
    fetchMock.mockReturnValueOnce(okJson({ success: false, error: "unavailable" }));
    expect(await resolveDirectAudioUrl("abc123")).toBeNull();
  });

  it("returns null on HTTP errors", async () => {
    fetchMock.mockReturnValueOnce(notFound());
    expect(await resolveDirectAudioUrl("abc123")).toBeNull();
  });

  it("returns null on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await resolveDirectAudioUrl("abc123")).toBeNull();
  });
});