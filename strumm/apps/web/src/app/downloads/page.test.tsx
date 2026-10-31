import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const player = vi.hoisted(() => ({
  playSong: vi.fn(),
  setPodcastMode: vi.fn(),
  setPlayerError: vi.fn(),
}));

const downloads = vi.hoisted(() => ({
  listAllDownloads: vi.fn(),
  removePodcastDownload: vi.fn(),
  preparePodcastDownloadPlayback: vi.fn(),
  prepareSongDownloadPlayback: vi.fn(),
  formatDownloadSize: (size: number) => (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`),
}));

const playHostAudioUrl = vi.hoisted(() => vi.fn());

vi.mock("web/store/usePlayerStore", () => ({
  usePlayerStore: () => ({
    playSong: player.playSong,
    setPodcastMode: player.setPodcastMode,
    setPlayerError: player.setPlayerError,
  }),
}));

vi.mock("web/lib/podcast-downloads", () => ({
  formatDownloadSize: downloads.formatDownloadSize,
  listAllDownloads: downloads.listAllDownloads,
  removePodcastDownload: downloads.removePodcastDownload,
  preparePodcastDownloadPlayback: downloads.preparePodcastDownloadPlayback,
  prepareSongDownloadPlayback: downloads.prepareSongDownloadPlayback,
}));

vi.mock("web/lib/host-audio", () => ({
  playHostAudioUrl: playHostAudioUrl,
}));

vi.mock("web/components/SafePodcastImage", () => ({
  default: () => null,
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children?: unknown; href?: string } & Record<string, unknown>) => <a {...(props as any)}>{children}</a>,
}));

import DownloadsPage from "./page";

const songRecord = {
  id: "song-video-123",
  videoId: "video-123",
  episodeId: "video-123",
  title: "Saved Track",
  showTitle: "Saved Artist",
  thumbnail: "",
  duration: 180,
  audioUrl: "https://assets.strumm.me/audio/track.mp3",
  mimeType: "audio/mpeg",
  collectionType: "song",
  collectionId: "songs",
  collectionName: "Songs",
  contentType: "song",
  size: 2048,
  savedAt: Date.now(),
  blob: new Blob(["audio bytes"], { type: "audio/mpeg" }),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("downloads page", () => {
  it("shows the empty library state when nothing has been saved", async () => {
    downloads.listAllDownloads.mockResolvedValue([]);
    downloads.prepareSongDownloadPlayback.mockReturnValue("blob:prepared");

    render(<DownloadsPage />);

    expect(await screen.findByText("Nothing saved yet")).toBeTruthy();
  });

  it("shows a retryable error and retries the load", async () => {
    downloads.listAllDownloads.mockRejectedValueOnce(new Error("Unable to open offline downloads."));

    render(<DownloadsPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Unable to open offline downloads/i)).toBeTruthy();

    downloads.listAllDownloads.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(downloads.listAllDownloads).toHaveBeenCalledTimes(2));
  });

  it("plays a saved offline song from the stored blob", async () => {
    downloads.listAllDownloads.mockResolvedValue([songRecord]);
    downloads.prepareSongDownloadPlayback.mockReturnValue("blob:prepared-url");
    playHostAudioUrl.mockResolvedValue(undefined);

    render(<DownloadsPage />);

    const playButton = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(playButton);

    await waitFor(() => expect(downloads.prepareSongDownloadPlayback).toHaveBeenCalledWith("video-123", songRecord.blob));
    await waitFor(() => expect(playHostAudioUrl).toHaveBeenCalledWith("blob:prepared-url"));
    await waitFor(() => expect(player.playSong).toHaveBeenCalledOnce());
    await waitFor(() => expect(player.setPodcastMode).toHaveBeenCalledWith("audio"));
  });
});
