import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import SongArtwork from "./SongArtwork";

const mocks = vi.hoisted(() => ({
  loadImage: vi.fn(() => Promise.resolve(true)),
  getArtworkCandidates: vi.fn(() => ["https://cdn.example.test/artwork.jpg"]),
}));

vi.mock("web/lib/image-loader", () => ({ loadImage: mocks.loadImage }));
vi.mock("web/lib/media", () => ({
  getArtworkCandidates: mocks.getArtworkCandidates,
  ARTWORK_QUALITY_MEDIUM: 80,
  ARTWORK_QUALITY_DATA_SAVER: 30,
}));

let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

class MockIntersectionObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observerCallback = callback;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  observerCallback = null;
});

describe("SongArtwork lazy loading", () => {
  it("does not request artwork until the tile approaches the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    render(<SongArtwork song={{ videoId: "track-1", thumbnail: "", title: "Track" }} />);

    expect(mocks.loadImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();

    act(() => observerCallback?.([{ isIntersecting: true }]));

    await waitFor(() => expect(mocks.loadImage).toHaveBeenCalledWith(
      "https://cdn.example.test/artwork.jpg",
      2,
    ));
    expect(await screen.findByRole("img")).toBeTruthy();
  });

  it("loads priority artwork immediately without waiting for intersection", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    render(<SongArtwork priority song={{ videoId: "track-2", thumbnail: "", title: "Priority" }} />);

    await waitFor(() => expect(mocks.loadImage).toHaveBeenCalledWith(
      "https://cdn.example.test/artwork.jpg",
      0,
    ));
  });
});
