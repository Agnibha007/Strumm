import { describe, it, expect, beforeEach } from "vitest";
import { useLastPlayedPlaylistStore } from "./useLastPlayedPlaylistStore";

beforeEach(() => {
  localStorage.clear();
  useLastPlayedPlaylistStore.getState().clear();
});

describe("useLastPlayedPlaylistStore", () => {
  it("starts empty", () => {
    expect(useLastPlayedPlaylistStore.getState().lastPlayed).toBeNull();
  });

  it("records a played playlist", () => {
    useLastPlayedPlaylistStore.getState().recordPlayed({
      id: "pl_1",
      name: "Late Night",
      songCount: 12,
      coverUrl: "https://example.com/art.jpg",
    });
    expect(useLastPlayedPlaylistStore.getState().lastPlayed).toEqual({
      id: "pl_1",
      name: "Late Night",
      songCount: 12,
      coverUrl: "https://example.com/art.jpg",
    });
  });

  it("overwrites the previous playlist on a new play", () => {
    useLastPlayedPlaylistStore.getState().recordPlayed({
      id: "pl_1",
      name: "First",
      songCount: 4,
    });
    useLastPlayedPlaylistStore.getState().recordPlayed({
      id: "pl_2",
      name: "Second",
      songCount: 8,
    });
    expect(useLastPlayedPlaylistStore.getState().lastPlayed?.id).toBe("pl_2");
  });

  it("clears the tracked playlist", () => {
    useLastPlayedPlaylistStore.getState().recordPlayed({
      id: "pl_1",
      name: "First",
      songCount: 4,
    });
    useLastPlayedPlaylistStore.getState().clear();
    expect(useLastPlayedPlaylistStore.getState().lastPlayed).toBeNull();
  });
});