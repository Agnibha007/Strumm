import { describe, expect, it } from "vitest";
import type { Song } from "@strumm/types";
import { appendRoomQueueSong, buildRoomPlaybackQueue, removeRoomQueueSong } from "./room-sync";

const song = (videoId: string) => ({ videoId, title: videoId, artist: "test" }) as Song;

describe("room playback queue reconciliation", () => {
  it("places the live track first and keeps upcoming order", () => {
    expect(buildRoomPlaybackQueue(song("current"), [song("next"), song("later")]).map((item) => item.videoId))
      .toEqual(["current", "next", "later"]);
  });

  it("does not duplicate the live track when it is also present in the room queue", () => {
    expect(buildRoomPlaybackQueue(song("current"), [song("current"), song("next")]).map((item) => item.videoId))
      .toEqual(["current", "next"]);
  });

  it("filters malformed queue entries from a room snapshot", () => {
    expect(buildRoomPlaybackQueue(song("current"), [null, {}, song("next")]).map((item) => item.videoId))
      .toEqual(["current", "next"]);
  });

  it("appends an incoming room queue event only once", () => {
    const current = [song("current")];
    expect(appendRoomQueueSong(appendRoomQueueSong(current, song("next")), song("next")).map((item) => item.videoId))
      .toEqual(["current", "next"]);
  });

  it("removes only the selected upcoming song", () => {
    expect(removeRoomQueueSong([song("current"), song("next"), song("later")], "next").map((item) => item.videoId))
      .toEqual(["current", "later"]);
  });
});
