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
export const CROSSFADE_START_SECONDS_BEFORE_END = 5;
// Position-driven crossfade fade-in ramp for the newly started track. Longer
// than the on-tab 800ms timer fade so a background tab (throttled to ~1 tick
// per second) still renders a perceptible ramp instead of a full-volume burst.
export const CROSSFADE_FADE_IN_MS = 2000;

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
