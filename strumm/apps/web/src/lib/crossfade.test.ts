import { describe, it, expect } from "vitest";
import {
  evaluateCrossfadeTick,
  backgroundCrossfadeProgress,
  CROSSFADE_MIN_DURATION_SECONDS,
  CROSSFADE_START_SECONDS_BEFORE_END,
  CROSSFADE_DURATION_MS,
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

describe("backgroundCrossfadeProgress", () => {
  const FADE_SECONDS = CROSSFADE_DURATION_MS / 1000;

  it("is at full volume (0) before the fade window starts", () => {
    expect(backgroundCrossfadeProgress(180, 200)).toBe(0);
    expect(backgroundCrossfadeProgress(200 - CROSSFADE_START_SECONDS_BEFORE_END - 1, 200)).toBe(0);
  });

  it("reaches silence (1) when the fade-out has elapsed", () => {
    expect(backgroundCrossfadeProgress(200 - CROSSFADE_START_SECONDS_BEFORE_END + FADE_SECONDS, 200)).toBe(1);
    expect(backgroundCrossfadeProgress(200, 200)).toBe(1);
    expect(backgroundCrossfadeProgress(999, 200)).toBe(1);
  });

  it("is linear between full volume and silence across the fade", () => {
    const start = 200 - CROSSFADE_START_SECONDS_BEFORE_END;
    expect(backgroundCrossfadeProgress(start + FADE_SECONDS / 2, 200)).toBeCloseTo(0.5);
    expect(backgroundCrossfadeProgress(start + FADE_SECONDS / 4, 200)).toBeCloseTo(0.25);
  });

  it("treats unknown/zero durations as no fade", () => {
    expect(backgroundCrossfadeProgress(100, Number.NaN)).toBe(0);
    expect(backgroundCrossfadeProgress(100, 0)).toBe(0);
    expect(backgroundCrossfadeProgress(Number.NaN, 200)).toBe(0);
  });
});
