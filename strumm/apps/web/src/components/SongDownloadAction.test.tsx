import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SongDownloadAction from "./SongDownloadAction";

const store = vi.hoisted(() => ({
  getSongDownload: vi.fn(),
  saveSongDownload: vi.fn(),
  removeSongDownload: vi.fn(),
}));

const authFetchMock = vi.hoisted(() => vi.fn());
const apiUrlMock = vi.hoisted(() => vi.fn((path: string) => path));

vi.mock("web/lib/podcast-downloads", () => ({
  formatDownloadSize: (size: number) => size + " B",
  getAuthorizedSongDownloadUrl: (url?: string) => url || null,
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

const song = {
  videoId: "video-123",
  title: "Test Song",
  artist: "Test Artist",
  thumbnail: "https://assets.strumm.me/cover.jpg",
  duration: 180,
  metadata: {
    downloadUrl: "https://assets.strumm.me/audio/test.mp3",
  },
};

function okResponse() {
  return {
    ok: true,
    headers: {
      get: (name: string) => name.toLowerCase() === "content-type" ? "audio/mpeg" : null,
    },
    body: null,
    blob: async () => new Blob(["audio bytes"], { type: "audio/mpeg" }),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SongDownloadAction", () => {
  it("downloads via the backend endpoint when no authorized source URL is present", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => ({
      ...record,
      id: "song-video-123",
      episodeId: "video-123",
      showTitle: "Test Artist",
      collectionType: "song",
      collectionId: "songs",
      collectionName: "Songs",
      contentType: "song",
      size: record.blob.size,
      savedAt: Date.now(),
    }));
    authFetchMock.mockResolvedValue(okResponse());

    render(<SongDownloadAction song={{ ...song, metadata: {} }} compact />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith(
      "/download/video-123",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(store.saveSongDownload).toHaveBeenCalledWith(expect.objectContaining({
      videoId: song.videoId,
      title: song.title,
      artist: song.artist,
      audioUrl: "/download/video-123",
      mimeType: "audio/mpeg",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("downloads and saves a source-provided audio file", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => ({
      ...record,
      id: "song-video-123",
      episodeId: "video-123",
      showTitle: "Test Artist",
      collectionType: "song",
      collectionId: "songs",
      collectionName: "Songs",
      contentType: "song",
      size: record.blob.size,
      savedAt: Date.now(),
    }));
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<SongDownloadAction song={song as any} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(song.metadata.downloadUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(store.saveSongDownload).toHaveBeenCalledWith(expect.objectContaining({
      videoId: song.videoId,
      title: song.title,
      artist: song.artist,
      mimeType: "audio/mpeg",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("removes a saved song from local storage", async () => {
    const saved = {
      id: "song-video-123",
      videoId: song.videoId,
      title: song.title,
      artist: song.artist,
      thumbnail: song.thumbnail,
      duration: song.duration,
      audioUrl: song.metadata.downloadUrl,
      mimeType: "audio/mpeg",
      collectionType: "song",
      collectionId: "songs",
      collectionName: "Songs",
      contentType: "song",
      size: 11,
      savedAt: Date.now(),
      blob: new Blob(["audio bytes"], { type: "audio/mpeg" }),
    };
    store.getSongDownload.mockResolvedValue(saved);
    store.removeSongDownload.mockResolvedValue(undefined);

    render(<SongDownloadAction song={song as any} compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove downloaded song" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove downloaded song" }));

    await waitFor(() => expect(store.removeSongDownload).toHaveBeenCalledWith(song.videoId));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeTruthy());
  });
});
