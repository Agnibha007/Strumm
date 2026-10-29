import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PersistentPlayerWrapper from "./PersistentPlayerWrapper";
import { useAuthStore } from "web/store/useAuthStore";

const { playerState } = vi.hoisted(() => ({
  playerState: { currentSong: null as any },
}));

vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("web/store/usePlayerStore", () => ({
  usePlayerStore: (selector: (state: typeof playerState) => unknown) => selector(playerState),
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
    mockedAuthStore.mockReturnValue({
      user: { id: "user-1" } as any,
      token: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
    vi.clearAllMocks();
  });

  it("keeps the player mounted without auth when the network is offline", () => {
    mockedAuthStore.mockReturnValue({ user: null, token: null } as any);

    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
    expect(screen.getByTestId("editorial-player")).toBeTruthy();
    expect(screen.queryByTestId("player-state-sync")).toBeNull();
  });

  it("keeps the player mounted without auth while a downloaded podcast is selected", () => {
    playerState.currentSong = { videoId: "podcast-episode-1" };
    mockedAuthStore.mockReturnValue({ user: null, token: null } as any);

    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
    expect(screen.getByTestId("editorial-player")).toBeTruthy();
    expect(screen.queryByTestId("player-state-sync")).toBeNull();
  });
});
