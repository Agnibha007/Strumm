import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SongDownloadAction from "./SongDownloadAction";
import { usePlayerStore } from "web/store/usePlayerStore";

const store = vi.hoisted(() => ({
  getSongDownload: vi.fn(),
  saveSongDownload: vi.fn(),
  removeSongDownload: vi.fn(),
}));

const browserDownloadMock = vi.hoisted(() => vi.fn());

vi.mock("web/lib/podcast-downloads", () => ({
  formatDownloadSize: (size: number) => size + " B",
  getSongDownload: store.getSongDownload,
  saveSongDownload: store.saveSongDownload,
  removeSongDownload: store.removeSongDownload,
}));

vi.mock("web/lib/browser-song-download", () => ({
  downloadSongInBrowser: (...args: unknown[]) => browserDownloadMock(...args),
}));

const baseSong = {
  videoId: "abcdefghijk",
  title: "Test Song",
  artist: "Test Artist",
  thumbnail: "https://assets.strumm.me/cover.jpg",
  duration: 172,
  metadata: {},
};

function browserResult() {
  return {
    blob: new Blob(["audio bytes"], { type: "audio/mp4" }),
    mimeType: "audio/mp4",
    audioUrl: "https://r1.googlevideo.com/videoplayback?id=abcdefghijk",
    sourceProvider: "direct",
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
  browserDownloadMock.mockImplementation(async (_song, _signal, onProgress) => {
    onProgress(65);
    return browserResult();
  });
});

afterEach(() => {
  cleanup();
  usePlayerStore.setState({ currentSong: null });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SongDownloadAction", () => {
  it("streams audio into the browser and saves it to the offline library", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(browserDownloadMock).toHaveBeenCalledOnce());
    expect(browserDownloadMock).toHaveBeenCalledWith(
      baseSong,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(store.saveSongDownload).toHaveBeenCalledWith(expect.objectContaining({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      audioUrl: "https://r1.googlevideo.com/videoplayback?id=abcdefghijk",
      mimeType: "audio/mp4",
      sourceProvider: "direct",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("does not use a song metadata download URL as a replacement for extraction", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
    const song = {
      ...baseSong,
      metadata: { downloadUrl: "https://assets.strumm.me/audio/test.mp3" },
    };

    render(<SongDownloadAction song={song} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(store.saveSongDownload).toHaveBeenCalledOnce());
    expect(browserDownloadMock).toHaveBeenCalledOnce();
  });

  it("shows the audio resolution error without saving an incomplete file", async () => {
    store.getSongDownload.mockResolvedValue(null);
    browserDownloadMock.mockRejectedValue(new Error("No browser-compatible audio stream was found for this track."));

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No browser-compatible audio stream"));
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });

  it("shows message details from non-Error download failures", async () => {
    store.getSongDownload.mockResolvedValue(null);
    browserDownloadMock.mockRejectedValue({ message: "WebAssembly resolver initialization failed" });

    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("audio resolution: WebAssembly resolver initialization failed"));
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });

  it("removes a saved song using its original YouTube ID", async () => {
    store.getSongDownload.mockResolvedValue(savedRecord({
      videoId: "abcdefghijk",
      title: "Test Song",
      artist: "Test Artist",
      thumbnail: baseSong.thumbnail,
      duration: baseSong.duration,
      audioUrl: "https://r1.googlevideo.com/videoplayback?id=abcdefghijk",
      mimeType: "audio/mp4",
      blob: new Blob(["audio bytes"], { type: "audio/mp4" }),
    }));
    store.removeSongDownload.mockResolvedValue(undefined);

    render(<SongDownloadAction song={baseSong} compact />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove downloaded song" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove downloaded song" }));

    await waitFor(() => expect(store.removeSongDownload).toHaveBeenCalledWith("abcdefghijk"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download song offline" })).toBeTruthy());
  });

  it("resets the Saved button after playback advances but keeps the offline record", async () => {
    store.getSongDownload.mockResolvedValue(null);
    store.saveSongDownload.mockImplementation(async (record) => savedRecord(record));
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

  it("does not start browser extraction when the user declines the rights confirmation", async () => {
    store.getSongDownload.mockResolvedValue(null);
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<SongDownloadAction song={baseSong} compact />);
    fireEvent.click(screen.getByRole("button", { name: "Download song offline" }));
    expect(browserDownloadMock).not.toHaveBeenCalled();
    expect(store.saveSongDownload).not.toHaveBeenCalled();
  });
});
