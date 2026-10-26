import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Song } from "@strumm/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const authFetch = vi.fn();
vi.mock("web/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

vi.mock("web/components/BrandLogo", () => ({ default: () => null }));

import SharePage from "./page";
import { useAuthStore } from "web/store/useAuthStore";
import { usePlayerStore } from "web/store/usePlayerStore";

const SONG = {
  videoId: "song-1",
  title: "Shared Song",
  artist: "An Artist",
  thumbnail: "",
  duration: 200,
} as Song;

function mockShareResponse(contentType: "song" | "playlist", content: unknown) {
  authFetch.mockResolvedValue({
    json: async () => ({
      success: true,
      data: { contentType, content, views: 3 },
    }),
  });
}

async function renderShare() {
  // `use(params)` suspends on the promise, so the page needs a boundary and the
  // render has to be awaited for React to flush the unsuspension.
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SharePage params={Promise.resolve({ token: "tok123" })} />
      </Suspense>,
    );
  });
}

describe("shared link playback for a signed-out visitor", () => {
  beforeEach(() => {
    push.mockReset();
    authFetch.mockReset();
    useAuthStore.setState({ user: null, token: null });
    usePlayerStore.setState({ currentSong: null, queue: [], currentIndex: -1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the track and a sign-in CTA instead of silently dropping the selection", async () => {
    mockShareResponse("song", SONG);

    await renderShare();

    await screen.findByText("Shared Song");

    // Regression: the old page called playSong() then pushed "/" for everyone.
    // For a guest there is no mounted player, so the track vanished.
    expect(screen.getByRole("button", { name: /sign in to play/i })).toBeTruthy();
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("sends a guest to login with the share preserved as the return destination", async () => {
    mockShareResponse("song", SONG);
    await renderShare();

    await screen.findByText("Shared Song");
    screen.getByRole("button", { name: /sign in to play/i }).click();

    expect(push).toHaveBeenCalledWith("/login?redirect=%2Fshare%2Ftok123");
    expect(usePlayerStore.getState().currentSong).toBeNull();
  });

  it("plays a shared playlist only when the visitor is signed in", async () => {
    useAuthStore.setState({
      user: { id: "u1", username: "u", email: "u@example.com" } as any,
      token: "jwt",
    });
    mockShareResponse("playlist", {
      id: "pl1",
      name: "Shared Playlist",
      songs: [SONG],
      songCount: 1,
    });

    await renderShare();

    await waitFor(() => {
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("song-1");
    });
    expect(push).toHaveBeenCalledWith("/");
  });

  it("does not crash on a shared playlist with no usable songs", async () => {
    useAuthStore.setState({
      user: { id: "u1", username: "u", email: "u@example.com" } as any,
      token: "jwt",
    });
    mockShareResponse("playlist", { id: "pl1", name: "Broken", songs: undefined });

    await renderShare();

    await screen.findByText("Broken");
    // Nothing to play, but the user is still handed to the app.
    expect(usePlayerStore.getState().currentSong).toBeNull();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("still reports a genuinely dead link", async () => {
    authFetch.mockResolvedValue({
      json: async () => ({ success: false, error: "Shared content not found." }),
    });

    await renderShare();

    await screen.findByText("Failed to Load Content");
    expect(screen.getByText("Shared content not found.")).toBeTruthy();
  });
});
