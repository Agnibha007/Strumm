import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PodcastDownloadAction from "./PodcastDownloadAction";

const store = vi.hoisted(() => ({
  getPodcastDownload: vi.fn(),
  savePodcastDownload: vi.fn(),
  removePodcastDownload: vi.fn(),
}));

const authFetch = vi.hoisted(() => vi.fn());

vi.mock("web/lib/podcast-downloads", () => ({
  formatDownloadSize: (size: number) => size + " B",
  getPodcastDownload: store.getPodcastDownload,
  savePodcastDownload: store.savePodcastDownload,
  removePodcastDownload: store.removePodcastDownload,
}));

vi.mock("web/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

const episode = {
  id: "episode-1",
  title: "Example Episode",
  duration: 1200,
  audioUrl: "https://media.example.org/episodes/example.mp3",
  mediaType: "audio",
  videoAvailable: false,
} as any;

function okResponse(body: Blob, contentType = "audio/mpeg") {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    body: null,
    blob: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PodcastDownloadAction", () => {
  it("downloads an episode over the authenticated stream and saves it locally", async () => {
    store.getPodcastDownload.mockResolvedValue(null);
    store.savePodcastDownload.mockImplementation(async (record: any) => ({
      ...record,
      contentType: "podcast",
      collectionType: record.collectionType || "podcast",
      size: record.blob.size,
      savedAt: Date.now(),
    }));
    authFetch.mockResolvedValue(okResponse(new Blob(["audio bytes"], { type: "audio/mpeg" })));

    render(<PodcastDownloadAction episode={episode} showTitle="Example Show" sourceCollection={{ type: "podcast", id: "show-1", name: "Example Show" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/podcasts/episode/episode-1/download"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(store.savePodcastDownload).toHaveBeenCalledOnce();
    expect(store.savePodcastDownload).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: "episode-1",
      title: "Example Episode",
      showTitle: "Example Show",
      mimeType: "audio/mpeg",
      blob: expect.any(Blob),
    }));
    await waitFor(() => expect(screen.getByText("Saved offline")).toBeTruthy());
  });

  it("keeps the source restricted to the authenticated backend route", async () => {
    store.getPodcastDownload.mockResolvedValue(null);
    authFetch.mockResolvedValue(okResponse(new Blob(["audio bytes"], { type: "audio/mpeg" })));

    render(<PodcastDownloadAction episode={episode} showTitle="Example Show" />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url, init] = authFetch.mock.calls[0];
    expect(String(url)).not.toContain("https://media.example.org");
    expect(String(url)).toContain("/podcasts/episode/episode-1/download");
    expect(init?.method).toBeUndefined();
  });

  it("cancels an in-flight download without saving anything", async () => {
    store.getPodcastDownload.mockResolvedValue(null);
    store.savePodcastDownload.mockReset();

    // Abort-aware fetch: honour the AbortController so the in-flight download
    // actually rejects, like a real fetch does.
    authFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The download was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    render(<PodcastDownloadAction episode={episode} showTitle="Example Show" />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel download" });
    fireEvent.click(cancelButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeTruthy());
    await waitFor(() => expect(store.savePodcastDownload).not.toHaveBeenCalled());
  });

  it("surfaces a source failure without saving a partial blob", async () => {
    store.getPodcastDownload.mockResolvedValue(null);
    authFetch.mockResolvedValue({
      ok: false,
      status: 415,
      text: async () => JSON.stringify({ detail: "This episode's media format is not supported for downloads." }),
      headers: { get: () => null },
      body: null,
      blob: async () => new Blob([], { type: "audio/mpeg" }),
    } as unknown as Response);

    render(<PodcastDownloadAction episode={episode} showTitle="Example Show" />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText(/media format is not supported/i)).toBeTruthy();
    expect(store.savePodcastDownload).not.toHaveBeenCalled();
  });

  it("marks the episode as saved and can remove it again", async () => {
    const saved = {
      id: "podcast-episode-1",
      episodeId: "episode-1",
      title: "Example Episode",
      showTitle: "Example Show",
      thumbnail: "",
      duration: 1200,
      audioUrl: "https://media.example.org/episodes/example.mp3",
      mimeType: "audio/mpeg",
      collectionType: "podcast",
      collectionId: "show-1",
      collectionName: "Example Show",
      size: 11,
      savedAt: Date.now(),
      blob: new Blob(["audio bytes"], { type: "audio/mpeg" }),
    };
    store.getPodcastDownload.mockResolvedValue(saved);
    store.removePodcastDownload.mockResolvedValue(undefined);

    render(<PodcastDownloadAction episode={episode} showTitle="Example Show" sourceCollection={{ type: "podcast", id: "show-1", name: "Example Show" }} />);

    await waitFor(() => expect(screen.getByText("Saved offline")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove downloaded episode" }));

    await waitFor(() => expect(store.removePodcastDownload).toHaveBeenCalledWith("episode-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeTruthy());
  });
});
