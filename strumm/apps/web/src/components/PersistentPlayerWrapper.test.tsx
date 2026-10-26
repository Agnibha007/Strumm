import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PersistentPlayerWrapper from "./PersistentPlayerWrapper";
import { useAuthStore } from "web/store/useAuthStore";

const { playerState, routeState } = vi.hoisted(() => ({
  playerState: { currentSong: null as any },
  routeState: { pathname: "/search" },
}));

vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("web/store/usePlayerStore", () => ({
  usePlayerStore: (selector: (state: typeof playerState) => unknown) => selector(playerState),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routeState.pathname,
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="audio-engine" />,
}));

vi.mock("web/components/EditorialPlayer", () => ({
  default: () => <div data-testid="editorial-player" />,
}));

vi.mock("web/components/PlayerStateSync", () => ({
  default: () => <div data-testid="player-state-sync" />,
}));

vi.mock("web/components/AddToHomePrompt", () => ({
  default: () => <div data-testid="install-prompt" />,
}));

const mockedAuthStore = vi.mocked(useAuthStore);

describe("PersistentPlayerWrapper offline access", () => {
  const originalOnline = navigator.onLine;

  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    playerState.currentSong = null;
    routeState.pathname = "/search";
    mockedAuthStore.mockReturnValue({
      user: { id: "user-1" } as any,
      token: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    routeState.pathname = "/search";
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
    vi.clearAllMocks();
  });

  it("mounts the offline player when a cached user has no in-memory token", () => {
    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
    expect(screen.getByTestId("editorial-player")).toBeTruthy();
  });


  it("pre-mounts the audio engine on Downloads without a signed-in session", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    routeState.pathname = "/downloads";
    mockedAuthStore.mockReturnValue({ user: null, token: null } as any);

    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
    expect(screen.queryByTestId("editorial-player")).toBeNull();
  });

  it("mounts the player for a selected downloaded episode even without a session", () => {
    playerState.currentSong = { videoId: "podcast-episode-1" };
    mockedAuthStore.mockReturnValue({ user: null, token: null } as any);

    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
  });
});
