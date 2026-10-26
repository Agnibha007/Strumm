import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PersistentPlayerWrapper from "./PersistentPlayerWrapper";
import { useAuthStore } from "web/store/useAuthStore";

vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: vi.fn(),
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

  it("mounts the offline player when a cached user has no in-memory token", () => {
    render(<PersistentPlayerWrapper />);

    expect(screen.getByTestId("audio-engine")).toBeTruthy();
    expect(screen.getByTestId("editorial-player")).toBeTruthy();
  });

  it("still hides the player for users without a cached account", () => {
    mockedAuthStore.mockReturnValue({ user: null, token: null } as any);

    render(<PersistentPlayerWrapper />);

    expect(screen.queryByTestId("audio-engine")).toBeNull();
  });
});
