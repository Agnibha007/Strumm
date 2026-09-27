/**
 * Pure decision logic for the track crossfade.
 *
 * Extracted from AudioEngine so the crossfade trigger rules can be unit
 * tested in isolation. Semantics match the original inline logic exactly:
 * - Only songs longer than CROSSFADE_MIN_DURATION_SECONDS are eligible.
 * - When the track enters the final CROSSFADE_START_SECONDS_BEFORE_END
 *   seconds, a fade should be started (once) so the queue can advance.
 * - The fade-out runs over exactly CROSSFADE_START_SECONDS_BEFORE_END
 *   seconds of media time, so it completes at the track's end: the current
 *   song plays out in full and the next one begins at the transition (never
 *   before the previous song ends).
 * - If playback drops back out of that window (seek backwards) while a fade
 *   is in progress, the fade should be cancelled and volume restored.
 */

export const CROSSFADE_MIN_DURATION_SECONDS = 15;
/**
 * How long before the end of a track the crossfade begins.
 *
 * This is the audible length of the whole transition: it is the outgoing track's
 * fade-out, the window the incoming track ramps up across, and therefore how long
 * the two genuinely overlap. It was 5s, which is too short to read as a crossfade
 * — it lands as "the song dipped and something else started". 8s is long enough
 * to hear the old track sinking away while the new one rises out from under it,
 * while still leaving a track that ends promptly (podcasts, edits) intact.
 */
export const CROSSFADE_START_SECONDS_BEFORE_END = 8;
/**
 * Position-driven crossfade fade-in ramp for the newly started track.
 *
 * Only used when there is NO pre-staged overlap to blend in (the incoming
 * track's direct stream could not be resolved ahead of time), so this is the
 * fade-in half of a fade-through-silence boundary. It is deliberately a little
 * shorter than the fade-out half of the window so a track that starts quiet
 * reaches full volume promptly instead of lingering at half volume.
 */
export const CROSSFADE_FADE_IN_MS = 5000;
/**
 * Length of the crossfade window in milliseconds. The incoming track's overlap
 * ramp is driven by ITS OWN playback position across this window, so it reaches
 * full volume exactly as the outgoing track reaches silence — a true crossfade
 * that is completely independent of `setInterval` (and therefore unaffected by
 * the aggressive timer throttling hidden tabs apply).
 */
export const CROSSFADE_FADE_OUT_MS = CROSSFADE_START_SECONDS_BEFORE_END * 1000;

export type CrossfadeTickAction = "start-fade" | "cancel-fade" | "none";

/**
 * Decide what the crossfade machinery should do for one playback tick.
 *
 * @param currentTime - current playback position in seconds.
 * @param duration - total track duration in seconds (NaN/undefined for
 *   not-yet-known durations are treated as "not eligible").
 * @param fadeTriggered - whether the fade-out has already been started for
 *   this track (mirrors `hasTriggeredCrossfadeRef`).
 * @param repeatMode - player repeat mode. When "one" the current track
 *   replays instead of advancing, so a crossfade to the next track must
 *   never be started.
 */
export function evaluateCrossfadeTick(
  currentTime: number,
  duration: number,
  fadeTriggered: boolean,
  repeatMode: "none" | "all" | "one" = "none"
): CrossfadeTickAction {
  if (repeatMode === "one") return "none";
  if (duration > CROSSFADE_MIN_DURATION_SECONDS) {
    if (currentTime >= duration - CROSSFADE_START_SECONDS_BEFORE_END) {
      if (!fadeTriggered) return "start-fade";
    } else if (fadeTriggered) {
      return "cancel-fade";
    }
  }
  return "none";
}

/**
 * Linear fade-out progress for the background (host-audio) crossfade.
 *
 * Returns a value in [0, 1] for a track currently at `currentTime` of
 * `duration`: 0 = still at full volume, 1 = faded to silence (and the queue
 * should advance). The fade spans exactly the final
 * CROSSFADE_START_SECONDS_BEFORE_END seconds, so it reaches silence at the
 * track's end — the next track never starts before the previous one ends. It
 * is driven from the <audio> element's `timeupdate` events so it works in
 * hidden tabs where `setInterval`/`setTimeout` are throttled.
 *
 * @param currentTime - current playback position in seconds.
 * @param duration - total track duration in seconds (NaN/unknown durations
 *   yield 0, i.e. no fade).
 */
export function backgroundCrossfadeProgress(currentTime: number, duration: number): number {
  if (!isFinite(currentTime) || !isFinite(duration) || duration <= 0) return 0;
  const fadeStart = duration - CROSSFADE_START_SECONDS_BEFORE_END;
  const fadeSeconds = CROSSFADE_START_SECONDS_BEFORE_END;
  return Math.min(1, Math.max(0, (currentTime - fadeStart) / fadeSeconds));
}

/**
 * How close to the very end counts as "the crossfade window has run out".
 *
 * `backgroundCrossfadeProgress` only reaches exactly 1 at
 * `currentTime === duration`, and no media pipeline reports that: `<audio>`
 * stops firing `timeupdate` a fraction of a second early, and the YouTube
 * player's `getCurrentTime()` never returns the duration at all. So a strict
 * `progress >= 1` test made the engine's own boundary almost unreachable — the
 * crossfade only ever completed because some *other* mechanism (the `ended`
 * event, the near-end advance, the hidden-tab watchdog) happened to fire.
 *
 * That matters off-tab, where those other mechanisms are exactly the ones that
 * get throttled or dropped. With a small tolerance the crossfade boundary is
 * driven by the crossfade itself, from its own position, identically in a
 * foreground tab and a locked one.
 */
export const CROSSFADE_COMPLETION_TOLERANCE_SECONDS = 0.35;

export function crossfadeWindowComplete(
  currentTime: number,
  duration: number,
  toleranceSeconds = CROSSFADE_COMPLETION_TOLERANCE_SECONDS
): boolean {
  if (!isFinite(currentTime) || !isFinite(duration) || duration <= 0) return false;
  return currentTime >= duration - toleranceSeconds;
}

/**
 * Linear fade-in progress for a crossfaded-in track, derived from its playback
 * position so the ramp converges even when `setInterval` is throttled (hidden
 * tab). Returns 0 = still silent at the very start, 1 = full volume once
 * CROSSFADE_FADE_IN_MS of media time has elapsed.
 *
 * @param currentTime - current playback position in seconds of the NEW track.
 */
export function crossfadeFadeInRatio(currentTime: number): number {
  if (!isFinite(currentTime) || currentTime <= 0) return 0;
  return Math.min(1, currentTime / (CROSSFADE_FADE_IN_MS / 1000));
}

/**
 * Fade-in ratio for the INCOMING track during a true-overlap crossfade.
 *
 * The incoming track is started CROSSFADE_START_SECONDS_BEFORE_END seconds
 * before the outgoing track ends, so ramping it across that same window makes
 * it reach full volume exactly as the outgoing track reaches silence. Driven by
 * the incoming element's own media time, so it behaves identically in a
 * foreground tab and a hidden one.
 */
export function crossfadeOverlapFadeInRatio(currentTime: number): number {
  if (!isFinite(currentTime) || currentTime <= 0) return 0;
  return Math.min(1, currentTime / (CROSSFADE_START_SECONDS_BEFORE_END));
}

/**
 * Volume multiplier (1 → 0) for a track that is fading OUT, derived from its
 * own playback position.
 *
 * Deliberately a pure function of the element's own media time rather than a
 * `setInterval` ramp: hidden tabs throttle timers to ~1 tick/second (and to
 * 1 tick/minute once the tab has been backgrounded for a while), which
 * stretched the old timer fade to 15–300 real seconds and was the source of the
 * "huge delay between songs". Media-position ramps are immune to throttling
 * because the `<audio>` element keeps playing and keeps firing `timeupdate`.
 *
 * @param currentTime - current playback position in seconds.
 * @param duration - total track duration in seconds (NaN/unknown → 1, no fade).
 */
export function crossfadeFadeOutRatio(currentTime: number, duration: number): number {
  if (!isFinite(currentTime) || !isFinite(duration) || duration <= 0) return 1;
  return 1 - backgroundCrossfadeProgress(currentTime, duration);
}

export interface CrossfadeVolumeInput {
  /** True while the audible track is still ramping in from silence. */
  fadeInPending: boolean;
  /** Playback position of the audible (fading-in) track, in seconds. */
  fadeInTime: number;
  /** True while the audible track is ramping out toward silence. */
  fadingOut: boolean;
  /** Playback position of the audible (fading-out) track, in seconds. */
  fadeOutTime: number;
  /** Total duration of the audible (fading-out) track, in seconds. */
  duration: number;
  /** The ratio the caller WANTS (1 = steady state). Used only when no crossfade ramp is active. */
  desired: number;
}

/**
 * The single authority for a track's crossfade volume ratio.
 *
 * Every code path that touches the audible element's volume MUST go through
 * this, because the bug this prevents is two writers disagreeing about the
 * same element:
 *
 *   1. the track-change effect activates the new stream and sets it to FULL
 *      volume (it is about to play, so full volume is "correct" in isolation);
 *   2. a tick later the position-driven fade-in runs and computes a ratio of
 *      ~0, because a track 0.1s into playback IS at crossfadeFadeInRatio(0.1).
 *
 * The result was audible as: full-volume burst → volume slams to near-silence
 * → ramp back up over CROSSFADE_FADE_IN_MS. ("Plays suddenly then fades out
 * then fades back in".)
 *
 * The invariant encoded here: while a crossfade ramp is armed, the ramp OWNS
 * the volume and no caller can force it to `desired`. A ramp always converges
 * to 1 exactly when the track reaches CROSSFADE_FADE_IN_MS of media time, so
 * suppressing `desired` can never leave a track stuck quiet.
 */
export function crossfadeVolumeRatio(input: CrossfadeVolumeInput): number {
  if (input.fadeInPending) {
    return crossfadeFadeInRatio(input.fadeInTime);
  }
  if (input.fadingOut) {
    return crossfadeFadeOutRatio(input.fadeOutTime, input.duration);
  }
  const desired = input.desired;
  if (!isFinite(desired)) return 1;
  return Math.min(1, Math.max(0, desired));
}
