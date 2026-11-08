import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const player = vi.hoisted(() => ({
  playSong: vi.fn(),
  setPodcastMode: vi.fn(),
  setPlayerError: vi.fn(),
}));

const downloads = vi.hoisted(() => ({
  listAllDownloads: vi.fn(),
  authFetch: vi.fn(),
  apiUrl: (path: string) => path,
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

vi.mock("web/lib/auth-client", () => ({ authFetch: downloads.authFetch }));
vi.mock("web/lib/api", () => ({ apiUrl: downloads.apiUrl }));

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

  it("exports a saved non-MP3 podcast as MP3 through the conversion endpoint", async () => {
    const m4aRecord = { ...podcastRecord, mimeType: "audio/mp4", blob: new Blob(["m4a bytes"], { type: "audio/mp4" }) };
    downloads.listAllDownloads.mockResolvedValue([m4aRecord]);
    downloads.authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(["mp3 bytes"], { type: "audio/mpeg" }) });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mp3"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<DownloadsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Saved Episode as MP3" }));

    await waitFor(() => expect(downloads.authFetch).toHaveBeenCalledOnce());
    const [url, init] = downloads.authFetch.mock.calls[0];
    expect(url).toBe("/podcasts/convert/mp3");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("title")).toBe("Saved Episode");
    const uploadedFile = (init.body as FormData).get("file");
    expect(uploadedFile).toBeInstanceOf(File);
    if (!(uploadedFile instanceof File)) throw new Error("Expected the converted upload to be a File");
    expect(await uploadedFile.text()).toBe("m4a bytes");
  });

  it("exports an already-MP3 podcast without calling the conversion endpoint", async () => {
    downloads.listAllDownloads.mockResolvedValue([podcastRecord]);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mp3"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<DownloadsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Saved Episode as MP3" }));

    await waitFor(() => expect(downloads.authFetch).not.toHaveBeenCalled());
  });

});
