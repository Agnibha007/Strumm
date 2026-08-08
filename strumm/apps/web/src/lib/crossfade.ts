/**
 * Pure decision logic for the track crossfade.
 *
 * Extracted from AudioEngine so the crossfade trigger rules can be unit
 * tested in isolation. Semantics match the original inline logic exactly:
 * - Only songs longer than CROSSFADE_MIN_DURATION_SECONDS are eligible.
 * - When the track enters the final CROSSFADE_START_SECONDS_BEFORE_END
 *   seconds, a fade should be started (once) so the queue can advance.
 * - If playback drops back out of that window (seek backwards) while a fade
 *   is in progress, the fade should be cancelled and volume restored.
 */

export const CROSSFADE_MIN_DURATION_SECONDS = 15;
export const CROSSFADE_START_SECONDS_BEFORE_END = 10;
export const CROSSFADE_DURATION_MS = 5000;

export type CrossfadeTickAction = "start-fade" | "cancel-fade" | "none";

/**
 * Decide what the crossfade machinery should do for one playback tick.
 *
 * @param currentTime - current playback position in seconds.
 * @param duration - total track duration in seconds (NaN/undefined for
 *   not-yet-known durations are treated as "not eligible").
 * @param fadeTriggered - whether the fade-out has already been started for
 *   this track (mirrors `hasTriggeredCrossfadeRef`).
 */
export function evaluateCrossfadeTick(
  currentTime: number,
  duration: number,
  fadeTriggered: boolean
): CrossfadeTickAction {
  if (duration > CROSSFADE_MIN_DURATION_SECONDS) {
    if (currentTime >= duration - CROSSFADE_START_SECONDS_BEFORE_END) {
      if (!fadeTriggered) return "start-fade";
    } else if (fadeTriggered) {
      return "cancel-fade";
    }
  }
  return "none";
}
