import { describe, it, expect } from "vitest";
import {
  evaluateCrossfadeTick,
  backgroundCrossfadeProgress,
  crossfadeWindowComplete,
  crossfadeFadeInRatio,
  crossfadeFadeOutRatio,
  crossfadeOverlapFadeInRatio,
  crossfadeVolumeRatio,
  CROSSFADE_MIN_DURATION_SECONDS,
  CROSSFADE_START_SECONDS_BEFORE_END,
  CROSSFADE_FADE_IN_MS,
  CROSSFADE_FADE_OUT_MS,
  CROSSFADE_COMPLETION_TOLERANCE_SECONDS,
} from "./crossfade";

describe("evaluateCrossfadeTick", () => {
  it("starts a fade when the track enters the final window", () => {
    expect(evaluateCrossfadeTick(195, 200, false)).toBe("start-fade");
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
    expect(evaluateCrossfadeTick(195, 200, false, "one")).toBe("none");
  });

  it("does not cancel an existing fade when repeat mode is 'one'", () => {
    expect(evaluateCrossfadeTick(180, 200, true, "one")).toBe("none");
  });

  it("defaults to no repeat mode (crossfade allowed) when not provided", () => {
    expect(evaluateCrossfadeTick(195, 200, false, "all")).toBe("start-fade");
    expect(evaluateCrossfadeTick(195, 200, false)).toBe("start-fade");
  });
});

describe("backgroundCrossfadeProgress", () => {
  const FADE_SECONDS = CROSSFADE_START_SECONDS_BEFORE_END;

  it("is at full volume (0) before the fade window starts", () => {
    expect(backgroundCrossfadeProgress(180, 200)).toBe(0);
    expect(backgroundCrossfadeProgress(200 - CROSSFADE_START_SECONDS_BEFORE_END - 1, 200)).toBe(0);
  });

  it("reaches silence (1) when the fade-out has elapsed", () => {
    expect(backgroundCrossfadeProgress(200 - CROSSFADE_START_SECONDS_BEFORE_END + FADE_SECONDS, 200)).toBe(1);
    expect(backgroundCrossfadeProgress(200, 200)).toBe(1);
    expect(backgroundCrossfadeProgress(999, 200)).toBe(1);
  });

  it("reaches silence exactly at the track end, never earlier", () => {
    // The fade-out window spans the final CROSSFADE_START_SECONDS_BEFORE_END
    // seconds, so just before the end the tail is still audible and silence (and
    // the queue advance) lands on the track's end. Derived from the constant so
    // retuning the window does not silently invalidate the assertion.
    expect(backgroundCrossfadeProgress(200 - 0.5, 200)).toBeCloseTo(1 - 0.5 / FADE_SECONDS);
    expect(backgroundCrossfadeProgress(200, 200)).toBe(1);
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

describe("crossfadeFadeInRatio", () => {
  const FADE_IN_SECONDS = CROSSFADE_FADE_IN_MS / 1000;

  it("is silent (0) before playback and at the very start", () => {
    expect(crossfadeFadeInRatio(0)).toBe(0);
    expect(crossfadeFadeInRatio(-5)).toBe(0);
    expect(crossfadeFadeInRatio(Number.NaN)).toBe(0);
    expect(crossfadeFadeInRatio(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("reaches full volume (1) once the fade-in media time has elapsed", () => {
    expect(crossfadeFadeInRatio(FADE_IN_SECONDS)).toBe(1);
    expect(crossfadeFadeInRatio(FADE_IN_SECONDS * 2)).toBe(1);
    expect(crossfadeFadeInRatio(999)).toBe(1);
  });

  it("is linear between silence and full volume across the ramp", () => {
    expect(crossfadeFadeInRatio(FADE_IN_SECONDS / 2)).toBeCloseTo(0.5);
    expect(crossfadeFadeInRatio(FADE_IN_SECONDS / 4)).toBeCloseTo(0.25);
  });
});

describe("crossfadeFadeOutRatio", () => {
  const WINDOW_START = 200 - CROSSFADE_START_SECONDS_BEFORE_END;

  it("is the exact inverse of backgroundCrossfadeProgress", () => {
    // WINDOW_START is the first instant of the window (progress 0 → still full
    // volume), the midpoint is halfway down, and 200 is silence.
    expect(crossfadeFadeOutRatio(180, 200)).toBe(1);
    expect(crossfadeFadeOutRatio(WINDOW_START, 200)).toBe(1);
    expect(crossfadeFadeOutRatio(WINDOW_START + CROSSFADE_START_SECONDS_BEFORE_END / 2, 200)).toBeCloseTo(0.5);
    expect(crossfadeFadeOutRatio(200, 200)).toBe(0);
    expect(crossfadeFadeOutRatio(999, 200)).toBe(0);
  });

  it("holds at full volume for unknown/zero durations", () => {
    expect(crossfadeFadeOutRatio(100, Number.NaN)).toBe(1);
    expect(crossfadeFadeOutRatio(100, 0)).toBe(1);
    expect(crossfadeFadeOutRatio(Number.NaN, 200)).toBe(1);
  });

  it("reaches silence only at the track end, never earlier", () => {
    // Guards the "huge delay between songs" fix: the fade must consume exactly
    // the final CROSSFADE_FADE_OUT_MS of MEDIA time, so a throttled timer can't
    // stretch it and the advance lands on the track's real end.
    const dur = 200;
    expect(crossfadeFadeOutRatio(dur - CROSSFADE_START_SECONDS_BEFORE_END, dur)).toBe(1);
    expect(crossfadeFadeOutRatio(dur - 0.001, dur)).toBeGreaterThan(0);
    expect(crossfadeFadeOutRatio(dur, dur)).toBe(0);
    expect(CROSSFADE_FADE_OUT_MS).toBe(CROSSFADE_START_SECONDS_BEFORE_END * 1000);
  });
});

describe("crossfadeOverlapFadeInRatio", () => {
  it("reaches full volume exactly as the outgoing track reaches silence", () => {
    // The incoming track starts CROSSFADE_START_SECONDS_BEFORE_END seconds
    // early, so ramping it across the same window makes the two curves meet at
    // the boundary — that is what makes it a crossfade rather than a handoff.
    const dur = 200;
    const overlapStart = dur - CROSSFADE_START_SECONDS_BEFORE_END;
    const elapsed = 2;
    expect(crossfadeOverlapFadeInRatio(0)).toBe(0);
    expect(crossfadeOverlapFadeInRatio(elapsed)).toBeCloseTo(
      1 - crossfadeFadeOutRatio(overlapStart + elapsed, dur)
    );
    expect(crossfadeOverlapFadeInRatio(CROSSFADE_START_SECONDS_BEFORE_END)).toBe(1);
  });

  it("is silent and clamped for invalid positions", () => {
    expect(crossfadeOverlapFadeInRatio(-3)).toBe(0);
    expect(crossfadeOverlapFadeInRatio(Number.NaN)).toBe(0);
    expect(crossfadeOverlapFadeInRatio(999)).toBe(1);
  });
});

describe("crossfadeWindowComplete", () => {
  it("completes slightly before the exact end, because no pipeline reports it", () => {
    // The bug this guards: `backgroundCrossfadeProgress` only reaches exactly 1
    // at currentTime === duration. `<audio>` stops firing timeupdate a fraction
    // of a second early and the YouTube player never reports the duration at
    // all, so a strict `progress >= 1` boundary almost never fired — the
    // crossfade only ever completed by accident, via whatever `ended`/watchdog
    // path happened to run first. Off-tab, where those are throttled or
    // dropped, the transition never completed at all.
    expect(crossfadeWindowComplete(200, 200)).toBe(true);
    expect(crossfadeWindowComplete(199.9, 200)).toBe(true);
    expect(
      crossfadeWindowComplete(200 - CROSSFADE_COMPLETION_TOLERANCE_SECONDS, 200)
    ).toBe(true);
  });

  it("stays open while there is still real fade-out left to play", () => {
    // Comfortably inside the window, and just outside the tolerance: both must
    // report "not done" so the fade is not truncated before it is audible.
    expect(crossfadeWindowComplete(200 - CROSSFADE_START_SECONDS_BEFORE_END, 200)).toBe(false);
    expect(
      crossfadeWindowComplete(200 - CROSSFADE_COMPLETION_TOLERANCE_SECONDS - 0.5, 200)
    ).toBe(false);
  });

  it("never completes on unknown or zero durations", () => {
    expect(crossfadeWindowComplete(100, Number.NaN)).toBe(false);
    expect(crossfadeWindowComplete(100, 0)).toBe(false);
    expect(crossfadeWindowComplete(Number.NaN, 200)).toBe(false);
  });

  it("honours a caller-supplied tolerance", () => {
    expect(crossfadeWindowComplete(195, 200, 10)).toBe(true);
    expect(crossfadeWindowComplete(195, 200, 1)).toBe(false);
  });
});

describe("crossfadeVolumeRatio", () => {
  const base = {
    fadeInPending: false,
    fadeInTime: 0,
    fadingOut: false,
    fadeOutTime: 0,
    duration: 200,
    desired: 1,
  };

  it("honours the caller's desired ratio when no ramp is active", () => {
    expect(crossfadeVolumeRatio(base)).toBe(1);
    expect(crossfadeVolumeRatio({ ...base, desired: 0.5 })).toBe(0.5);
  });

  it("clamps and sanitises the desired ratio", () => {
    expect(crossfadeVolumeRatio({ ...base, desired: 5 })).toBe(1);
    expect(crossfadeVolumeRatio({ ...base, desired: -1 })).toBe(0);
    expect(crossfadeVolumeRatio({ ...base, desired: Number.NaN })).toBe(1);
  });

  it("lets the fade-in ramp win over any desired value", () => {
    // The regression this encodes: activating a stream asked for `desired: 1`
    // while a fade-in was already armed and computing ~0 for a track a fraction
    // of a second old. Two writers, one element, opposite answers — audible as
    // "plays suddenly, then fades out, then fades back in".
    const fadeInSeconds = CROSSFADE_FADE_IN_MS / 1000;
    expect(
      crossfadeVolumeRatio({
        ...base,
        fadeInPending: true,
        fadeInTime: 0,
        desired: 1,
      })
    ).toBe(0);
    expect(
      crossfadeVolumeRatio({
        ...base,
        fadeInPending: true,
        fadeInTime: fadeInSeconds / 2,
        desired: 1,
      })
    ).toBeCloseTo(0.5);
  });

  it("lets the fade-in win over an active fade-out (the ramp is newer)", () => {
    expect(
      crossfadeVolumeRatio({
        ...base,
        fadeInPending: true,
        fadeInTime: CROSSFADE_FADE_IN_MS / 4000,
        fadingOut: true,
        fadeOutTime: 199,
        desired: 1,
      })
    ).toBeCloseTo(0.25);
  });

  it("lets the fade-out ramp win over any desired value", () => {
    const windowStart = 200 - CROSSFADE_START_SECONDS_BEFORE_END;
    expect(
      crossfadeVolumeRatio({
        ...base,
        fadingOut: true,
        fadeOutTime: windowStart + CROSSFADE_START_SECONDS_BEFORE_END / 2,
        desired: 1,
      })
    ).toBeCloseTo(0.5);
    expect(
      crossfadeVolumeRatio({ ...base, fadingOut: true, fadeOutTime: 200, desired: 1 })
    ).toBe(0);
  });

  it("converges to full volume so a ramp can never strand a track quiet", () => {
    expect(
      crossfadeVolumeRatio({ ...base, fadeInPending: true, fadeInTime: 999, desired: 0 })
    ).toBe(1);
    expect(
      crossfadeVolumeRatio({ ...base, fadingOut: true, fadeOutTime: 0, desired: 0 })
    ).toBe(1);
  });
});
