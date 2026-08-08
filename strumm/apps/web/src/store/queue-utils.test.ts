import { describe, it, expect } from "vitest";
import { resolveNextTrackIndex } from "./queue-utils";
import { Song } from "@strumm/types";

function makeSong(id: string): Song {
  return { videoId: id, title: id, artist: "test", duration: 120 } as Song;
}

const queue = [makeSong("a"), makeSong("b"), makeSong("c")];

describe("resolveNextTrackIndex", () => {
  describe("empty queue", () => {
    it("returns null", () => {
      expect(resolveNextTrackIndex([], 0, "none", false, true)).toBeNull();
    });
  });

  describe("sequential (no shuffle)", () => {
    it("advances to the next track", () => {
      expect(resolveNextTrackIndex(queue, 0, "none", false, false)).toBe(1);
      expect(resolveNextTrackIndex(queue, 1, "none", false, false)).toBe(2);
    });

    it("wraps to the start when repeat is 'all' and queue ends", () => {
      expect(resolveNextTrackIndex(queue, 2, "all", false, false)).toBe(0);
      expect(resolveNextTrackIndex(queue, 2, "all", false, true)).toBe(0);
    });

    it("stops (null) when repeat is 'none' and queue ends on track end", () => {
      expect(resolveNextTrackIndex(queue, 2, "none", false, true)).toBeNull();
    });

    it("holds the last track when repeat is 'none' and advance is manual", () => {
      expect(resolveNextTrackIndex(queue, 2, "none", false, false)).toBe(2);
    });

    it("returns the last track index when repeat is 'one' and queue ends", () => {
      expect(resolveNextTrackIndex(queue, 2, "one", false, true)).toBeNull();
      expect(resolveNextTrackIndex(queue, 2, "one", false, false)).toBe(2);
    });
  });

  describe("shuffle", () => {
    it("returns a valid, different index", () => {
      const next = resolveNextTrackIndex(queue, 0, "none", true, true, []);
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThanOrEqual(0);
      expect(next!).toBeLessThan(queue.length);
      expect(next).not.toBe(0);
    });

    it("prefers indices not yet played this round", () => {
      // only 'b' remains unplayed
      const next = resolveNextTrackIndex(queue, 0, "none", true, true, ["a", "c"]);
      expect(next).toBe(1);
    });

    it("restarts a new round when all songs have been played", () => {
      const next = resolveNextTrackIndex(queue, 0, "none", true, true, ["a", "b", "c"]);
      expect(next).not.toBeNull();
      expect(next).not.toBe(0); // still avoids repeating the current track
    });

    it("returns the current index when it is the only eligible one", () => {
      const next = resolveNextTrackIndex(queue, 1, "none", true, true, ["a", "c"]);
      expect(next).toBe(1);
    });

    describe("single-song queue", () => {
      it("returns 0 when repeating is allowed", () => {
        expect(resolveNextTrackIndex([makeSong("x")], 0, "none", true, false)).toBe(0);
        expect(resolveNextTrackIndex([makeSong("x")], 0, "all", true, true)).toBe(0);
      });

      it("returns null on track end with repeat 'none'", () => {
        expect(resolveNextTrackIndex([makeSong("x")], 0, "none", true, true)).toBeNull();
      });
    });
  });
});
