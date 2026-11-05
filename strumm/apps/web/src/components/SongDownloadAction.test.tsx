import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SongDownloadAction from "./SongDownloadAction";
import { usePlayerStore } from "web/store/usePlayerStore";

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

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  usePlayerStore.setState({ currentSong: null });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SongDownloadAction", () => {
  it("streams an MP3 from yt-dlp on demand and saves it to the browser library", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
    authFetchMock.mockResolvedValue(okResponse());

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith(
      "/proxy/downloads/song",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "abcdefghijk", title: "Test Song", artist: "Test Artist", duration: 172, rightsConfirmed: true }),
        signal: expect.any(AbortSignal),
      }),
    ));
    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(store.saveSongDownload).toHaveBeenCalledWith(expect.objectContaining({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      audioUrl: "/proxy/downloads/song",
      mimeType: "audio/mpeg",
      sourceProvider: "yt-dlp",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("uses the yt-dlp endpoint instead of a song's existing direct download URL", async () => {
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
      "/proxy/downloads/song",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ videoId: "abcdefghijk", title: "Test Song", artist: "Test Artist", duration: 172, rightsConfirmed: true }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains when yt-dlp cannot resolve an audio stream", async () => {
    store.getSongDownload.mockResolvedValue(null);
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ detail: "yt-dlp could not resolve an audio stream for this track." }),
    });

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("yt-dlp could not resolve"));
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });

  it("removes a saved song using its original YouTube ID", async () => {
    store.getSongDownload.mockResolvedValue(savedRecord({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      thumbnail: baseSong.thumbnail,
      duration: baseSong.duration,
      audioUrl: "/proxy/downloads/song",
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

  it("resets the transient Saved button after playback advances but keeps the offline record", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
    authFetchMock.mockResolvedValue(okResponse());
    act(() => usePlayerStore.setState({ currentSong: baseSong }));

    const { rerender } = render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    const nextSong = { ...baseSong, videoId: "lmnopqrstuv", title: "Next Song" };
    act(() => usePlayerStore.setState({ currentSong: nextSong }));
    rerender(<SongDownloadAction song={nextSong} compact />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download song offline" })).toBeTruthy());
    expect(store.saveSongDownload).toHaveBeenCalledOnce();
    expect(store.getSongDownload).toHaveBeenCalledOnce();
    expect(store.getSongDownload).toHaveBeenCalledWith(baseSong.videoId);
    expect(store.removeSongDownload).not.toHaveBeenCalled();
  });

  it("does not offer song downloads for podcast or non-YouTube provider IDs", async () => {
    store.getSongDownload.mockResolvedValue(null);
    const podcastSong = { ...baseSong, videoId: "podcast-123" };
    const audiusSong = { ...baseSong, videoId: "audius-KlK59" };
    const podcastView = render(<SongDownloadAction song={podcastSong} compact />);
    expect(podcastView.container.querySelector("button")).toBeNull();
    podcastView.unmount();
    const audiusView = render(<SongDownloadAction song={audiusSong} compact />);
    expect(audiusView.container.querySelector("button")).toBeNull();
  });

  it("does not call the download API when the user declines the rights confirmation", async () => {
    store.getSongDownload.mockResolvedValue(null);
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });
});
