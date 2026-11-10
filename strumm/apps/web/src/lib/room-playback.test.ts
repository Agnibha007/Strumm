import { describe, expect, it } from "vitest";
import { isNewRoomPlaybackCommand, isStaleRoomPlaybackSnapshot } from "./room-playback";

describe("room playback phase ordering", () => {
  it("accepts the first command and each forward phase transition", () => {
    expect(isNewRoomPlaybackCommand(1, "preparing", 0, "committed")).toBe(true);
    expect(isNewRoomPlaybackCommand(1, "committed", 1, "preparing")).toBe(true);
    expect(isStaleRoomPlaybackSnapshot(1, "preparing", 0, "committed")).toBe(false);
  });

  it("rejects a delayed preparing snapshot after the same sequence committed", () => {
    expect(isStaleRoomPlaybackSnapshot(4, "preparing", 4, "committed")).toBe(true);
    expect(isNewRoomPlaybackCommand(4, "preparing", 4, "committed")).toBe(false);
  });

  it("rejects older sequences and leaves duplicate snapshots non-command updates", () => {
    expect(isStaleRoomPlaybackSnapshot(3, "committed", 4, "preparing")).toBe(true);
    expect(isNewRoomPlaybackCommand(4, "committed", 4, "committed")).toBe(false);
    expect(isStaleRoomPlaybackSnapshot(4, "committed", 4, "committed")).toBe(false);
  });
});
