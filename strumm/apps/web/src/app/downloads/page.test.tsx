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

const podcastRecord = {
  id: "episode-123",
  episodeId: "episode-123",
  title: "Saved Episode",
  showTitle: "Example Podcast",
  thumbnail: "",
  duration: 180,
  audioUrl: "https://assets.strumm.me/audio/episode.mp3",
  mimeType: "audio/mpeg",
  collectionType: "podcast",
  collectionId: "show-123",
  collectionName: "Example Podcast",
  size: 2048,
  savedAt: Date.now(),
  blob: new Blob(["audio bytes"], { type: "audio/mpeg" }),
};

const songRecord = {
  ...podcastRecord,
  id: "song-video-123",
  videoId: "video-123",
  episodeId: "video-123",
  title: "Saved Track",
  showTitle: "Saved Artist",
  collectionType: "song",
  collectionId: "songs",
  collectionName: "Songs",
  contentType: "song",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("downloads page", () => {
  it("shows the empty library state when nothing has been saved", async () => {
    downloads.listAllDownloads.mockResolvedValue([]);

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

  it("hides legacy song downloads and plays saved podcast episodes", async () => {
    downloads.listAllDownloads.mockResolvedValue([songRecord, podcastRecord]);
    downloads.preparePodcastDownloadPlayback.mockReturnValue("blob:prepared-url");
    playHostAudioUrl.mockResolvedValue(undefined);

    render(<DownloadsPage />);

    expect(await screen.findByText("Saved Episode")).toBeTruthy();
    expect(screen.queryByText("Saved Track")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => expect(downloads.preparePodcastDownloadPlayback).toHaveBeenCalledWith("episode-123", podcastRecord.blob));
    await waitFor(() => expect(playHostAudioUrl).toHaveBeenCalledWith("blob:prepared-url"));
    await waitFor(() => expect(player.playSong).toHaveBeenCalledOnce());
    await waitFor(() => expect(player.setPodcastMode).toHaveBeenCalledWith("audio"));
  });
});
