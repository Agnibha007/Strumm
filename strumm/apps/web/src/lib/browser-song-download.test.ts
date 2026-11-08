import { afterEach, describe, expect, it, vi } from "vitest";
import { Ytdown } from "@4thel00z/ytdown";
import { downloadSongInBrowser, selectBrowserAudioFormat } from "./browser-song-download";

const format = (overrides: Record<string, unknown> = {}) => ({
  url: "https://r1.googlevideo.com/videoplayback?id=track",
  mime_type: "audio/webm; codecs=opus",
  audio: { bitrate: 128000, codec: "opus" },
  video: null,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("selectBrowserAudioFormat", () => {
  it("prefers audio-only M4A streams over WebM streams", () => {
    const webm = format({ audio: { bitrate: 160000 } });
    const m4a = format({
      mime_type: "audio/mp4; codecs=mp4a.40.2",
      audio: { bitrate: 128000 },
    });

    expect(selectBrowserAudioFormat([webm, m4a])).toBe(m4a);
  });

  it("selects the highest bitrate audio-only stream within the preferred container", () => {
    const lower = format({ audio: { bitrate: 96000 } });
    const higher = format({ audio: { bitrate: 160000 } });

    expect(selectBrowserAudioFormat([lower, higher])).toBe(higher);
  });

  it("falls back to an audio-bearing progressive MP4 stream", () => {
    const progressive = format({
      mime_type: "video/mp4; codecs=avc1,mp4a.40.2",
      video: { codec: "avc1" },
    });

    expect(selectBrowserAudioFormat([progressive])).toBe(progressive);
  });

  it("rejects non-HTTPS and non-GoogleVideo media URLs", () => {
    expect(() => selectBrowserAudioFormat([
      format({ url: "http://r1.googlevideo.com/videoplayback" }),
      format({ url: "https://example.com/audio.mp4" }),
    ])).toThrow("No browser-compatible audio stream");
  });

  it("rejects formats without an audio stream", () => {
    expect(() => selectBrowserAudioFormat([
      format({ audio: null, video: { codec: "avc1" } }),
    ])).toThrow("No browser-compatible audio stream");
  });
});

describe("downloadSongInBrowser", () => {
  it("resolves a track and streams the selected audio through the restricted proxy", async () => {
    vi.stubEnv("NEXT_PUBLIC_YTDOWN_PROXY_URL", "https://proxy.strumm.me");
    const resolvedFormat = format({
      mime_type: "audio/mp4; codecs=mp4a.40.2",
      audio: { bitrate: 128000 },
      http_headers: [["Referer", "https://www.youtube.com/"]],
    });
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ formats: [resolvedFormat] }),
    };
    vi.spyOn(Ytdown, "create").mockResolvedValue(resolver as never);
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      headers: {
        "content-type": "audio/mp4",
        "content-length": "5",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    const result = await downloadSongInBrowser(
      { videoId: "abcdefghijk", title: "Test Song" },
      new AbortController().signal,
      progress,
    );

    expect(Ytdown.create).toHaveBeenCalledWith({ proxy: "https://proxy.strumm.me" });
    expect(resolver.resolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abcdefghijk");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://proxy.strumm.me?url="),
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
        headers: expect.any(Headers),
      }),
    );
    expect(result.mimeType).toBe("audio/mp4");
    expect(result.blob.size).toBe(5);
    expect(result.sourceProvider).toBe("browser-wasm");
    expect(progress).toHaveBeenCalledWith(100);
  });
});
