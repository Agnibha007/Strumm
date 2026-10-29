import { describe, expect, it } from "vitest";
import { getAuthorizedSongDownloadUrl } from "./podcast-downloads";

describe("authorized song download URLs", () => {
  it("accepts an explicitly supplied first-party or licensed audio URL", () => {
    expect(getAuthorizedSongDownloadUrl("https://assets.strumm.me/music/track.mp3")).toBe(
      "https://assets.strumm.me/music/track.mp3",
    );
    expect(getAuthorizedSongDownloadUrl("/api/music/track.mp3")).toBe("/api/music/track.mp3");
  });

  it("rejects missing URLs and non-HTTP protocols", () => {
    expect(getAuthorizedSongDownloadUrl()).toBeNull();
    expect(getAuthorizedSongDownloadUrl("javascript:alert(1)")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("data:audio/mp3;base64,AAAA")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("//files.example.org/music.mp3")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("https://assets.example.org/music\\track.mp3")).toBeNull();
  });

  it("does not treat temporary YouTube or proxy stream URLs as download permission", () => {
    expect(getAuthorizedSongDownloadUrl("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("https://r3---sn.googlevideo.com/videoplayback?id=abc")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("https://pipedapi.kavin.rocks/streams/abc")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("http://assets.example.org/music.mp3")).toBeNull();
    expect(getAuthorizedSongDownloadUrl("https://piped.video/streams/abc")).toBeNull();
  });

  it("rejects URLs containing credentials", () => {
    expect(getAuthorizedSongDownloadUrl("https://user:pass@assets.strumm.me/music.mp3")).toBeNull();
  });
});
