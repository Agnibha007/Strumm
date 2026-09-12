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
 * should advance). The fade starts CROSSFADE_START_SECONDS_BEFORE_END seconds
 * before the end and reaches silence after CROSSFADE_DURATION_MS of media
 * time. It is driven from the <audio> element's `timeupdate` events so it
 * works in hidden tabs where `setInterval`/`setTimeout` are throttled.
 *
 * @param currentTime - current playback position in seconds.
 * @param duration - total track duration in seconds (NaN/unknown durations
 *   yield 0, i.e. no fade).
 */
export function backgroundCrossfadeProgress(currentTime: number, duration: number): number {
  if (!isFinite(currentTime) || !isFinite(duration) || duration <= 0) return 0;
  const fadeStart = duration - CROSSFADE_START_SECONDS_BEFORE_END;
  const fadeSeconds = CROSSFADE_DURATION_MS / 1000;
  return Math.min(1, Math.max(0, (currentTime - fadeStart) / fadeSeconds));
}
