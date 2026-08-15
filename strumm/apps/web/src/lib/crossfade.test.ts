import { describe, it, expect } from "vitest";
import {
  evaluateCrossfadeTick,
  CROSSFADE_MIN_DURATION_SECONDS,
  CROSSFADE_START_SECONDS_BEFORE_END,
} from "./crossfade";

describe("evaluateCrossfadeTick", () => {
  it("starts a fade when the track enters the final window", () => {
    expect(evaluateCrossfadeTick(190, 200, false)).toBe("start-fade");
    expect(evaluateCrossfadeTick(200, 200, false)).toBe("start-fade");
  });

  it("does not start a fade more than once for the same track", () => {
    expect(evaluateCrossfadeTick(195, 200, true)).toBe("none");
  });

  it("cancels the fade when playback drops out of the final window", () => {
    expect(evaluateCrossfadeTick(180, 200, true)).toBe("cancel-fade");
  });

  it("returns none when nothing changes outside the window", () => {
    expect(evaluateCrossfadeTick(0, 200, false)).toBe("none");
    expect(evaluateCrossfadeTick(180, 200, false)).toBe("none");
  });

  it("ignores tracks shorter than the minimum duration", () => {
    expect(evaluateCrossfadeTick(5, CROSSFADE_MIN_DURATION_SECONDS, false)).toBe("none");
    expect(evaluateCrossfadeTick(10, CROSSFADE_MIN_DURATION_SECONDS, false)).toBe("none");
    expect(evaluateCrossfadeTick(14, 15, false)).toBe("none");
  });

  it("handles exactly the minimum duration as ineligible", () => {
    // 15s is the minimum but not "> 15", so no crossfade
    expect(evaluateCrossfadeTick(14.9, 15, false)).toBe("none");
  });

  it("treats unknown/NaN durations as ineligible", () => {
    expect(evaluateCrossfadeTick(0, Number.NaN, false)).toBe("none");
    expect(evaluateCrossfadeTick(100, Number.NaN, true)).toBe("none");
  });

  it("treats zero duration as ineligible", () => {
    expect(evaluateCrossfadeTick(0, 0, false)).toBe("none");
  });

  it("never cancels when no fade was triggered", () => {
    expect(evaluateCrossfadeTick(0, 200, false)).toBe("none");
  });

  it("uses the configured window constants consistently", () => {
    // The window is CROSSFADE_START_SECONDS_BEFORE_END before the end
    const dur = 240;
    expect(evaluateCrossfadeTick(dur - CROSSFADE_START_SECONDS_BEFORE_END, dur, false)).toBe(
      "start-fade"
    );
    expect(evaluateCrossfadeTick(dur - CROSSFADE_START_SECONDS_BEFORE_END - 1, dur, false)).toBe(
      "none"
    );
  });

  it("never starts a fade when repeat mode is 'one'", () => {
    expect(evaluateCrossfadeTick(200, 200, false, "one")).toBe("none");
    expect(evaluateCrossfadeTick(190, 200, false, "one")).toBe("none");
  });

  it("does not cancel an existing fade when repeat mode is 'one'", () => {
    expect(evaluateCrossfadeTick(180, 200, true, "one")).toBe("none");
  });

  it("defaults to no repeat mode (crossfade allowed) when not provided", () => {
    expect(evaluateCrossfadeTick(190, 200, false, "all")).toBe("start-fade");
    expect(evaluateCrossfadeTick(190, 200, false)).toBe("start-fade");
  });
});
