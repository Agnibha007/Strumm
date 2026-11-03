import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SongDownloadAction from "./SongDownloadAction";

const store = vi.hoisted(() => ({
  getSongDownload: vi.fn(),
  saveSongDownload: vi.fn(),
  removeSongDownload: vi.fn(),
}));

const authFetchMock = vi.hoisted(() => vi.fn());
const apiUrlMock = vi.hoisted(() => vi.fn((path: string) => "/proxy" + path));

vi.mock("web/lib/podcast-downloads", () => ({
  formatDownloadSize: (size: number) => size + " B",
  getSongDownload: store.getSongDownload,
  saveSongDownload: store.saveSongDownload,
  removeSongDownload: store.removeSongDownload,
}));

vi.mock("web/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("web/lib/api", () => ({
  apiUrl: (path: string) => apiUrlMock(path),
}));

const baseSong = {
  videoId: "abcdefghijk",
  title: "Test Song",
  artist: "Test Artist",
  thumbnail: "https://assets.strumm.me/cover.jpg",
  duration: 172,
  metadata: {},
};

function okResponse() {
  const values: Record<string, string> = {
    "content-type": "audio/mpeg",
    "content-length": "11",
    "x-audius-source-url": "https://audius.co/artist/test-song",
    "x-audius-license": "All%20rights%20reserved",
    "x-audius-copyright-line": "Copyright%20Artist",
  };
  return {
    ok: true,
    headers: {
      get: (name: string) => values[name.toLowerCase()] ?? null,
    },
    body: null,
    blob: async () => new Blob(["audio bytes"], { type: "audio/mpeg" }),
  };
}

function savedRecord(record: Record<string, unknown>) {
  const videoId = String(record.videoId);
  return {
    ...record,
    id: "song-" + videoId,
    episodeId: videoId,
    showTitle: "Test Artist",
    collectionType: "song",
    collectionId: "songs",
    collectionName: "Songs",
    contentType: "song",
    size: 11,
    savedAt: Date.now(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SongDownloadAction", () => {
  it("downloads from Audius on demand while keeping the original song ID", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
    authFetchMock.mockResolvedValue(okResponse());

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith(
      "/proxy/audius/download",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test Song", artist: "Test Artist" }),
        signal: expect.any(AbortSignal),
      }),
    ));
    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(store.saveSongDownload).toHaveBeenCalledWith(expect.objectContaining({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      audioUrl: "/proxy/audius/download",
      mimeType: "audio/mpeg",
      sourceProvider: "audius",
      sourceUrl: "https://audius.co/artist/test-song",
      license: "All rights reserved",
      copyrightLine: "Copyright Artist",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("uses Audius instead of a song's existing direct download URL", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
    authFetchMock.mockResolvedValue(okResponse());
    const song = {
      ...baseSong,
      metadata: { downloadUrl: "https://assets.strumm.me/audio/test.mp3" },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SongDownloadAction song={song} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(authFetchMock).toHaveBeenCalledWith(
      "/proxy/audius/download",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains when Audius has no confidently matching public download", async () => {
    store.getSongDownload.mockResolvedValue(null);
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: "No confidently matching, publicly downloadable Audius track was found." }),
    });

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No confidently matching"));
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });

  it("removes a saved song using its original YouTube ID", async () => {
    store.getSongDownload.mockResolvedValue(savedRecord({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      thumbnail: baseSong.thumbnail,
      duration: baseSong.duration,
      audioUrl: "/proxy/audius/download",
      mimeType: "audio/mpeg",
      blob: new Blob(["audio bytes"], { type: "audio/mpeg" }),
    }));
    store.removeSongDownload.mockResolvedValue(undefined);

    render(<SongDownloadAction song={baseSong} compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove downloaded song" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove downloaded song" }));

    await waitFor(() => expect(store.removeSongDownload).toHaveBeenCalledWith("abcdefghijk"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download song offline" })).toBeTruthy());
  });

  it("does not offer song downloads for podcast episodes", async () => {
    store.getSongDownload.mockResolvedValue(null);
    const podcastSong = { ...baseSong, videoId: "podcast-123" };
    const { container } = render(<SongDownloadAction song={podcastSong} compact />);
    await waitFor(() => expect(store.getSongDownload).toHaveBeenCalledWith("podcast-123"));
    expect(container.querySelector("button")).toBeNull();
  });
});
