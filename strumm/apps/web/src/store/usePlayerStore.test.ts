/**
 * Store-level invariants for the two behaviours that produced the worst
 * reported playback bugs:
 *
 *  1. Picking a SINGLE search result must play that one song and then continue
 *     into the mix — never enqueue the rest of the result list.
 *  2. An explicit pause is a hard stop: no auto-advance path may resurrect
 *     playback afterwards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Song } from "@strumm/types";
import { usePlayerStore } from "./usePlayerStore";

const song = (videoId: string, title = videoId): Song =>
  ({
    videoId,
    title,
    artist: `artist-${videoId}`,
    thumbnail: "",
  }) as Song;

const PICKED = song("picked", "Picked Song");
const OTHER_1 = song("other1", "Other One");
const OTHER_2 = song("other2", "Other Two");

function reset() {
  usePlayerStore.setState({
    currentSong: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    shufflePlayedIds: [],
    isShuffle: false,
    repeatMode: "none",
    isRadio: false,
    isRadioLoading: false,
    radioSeed: null,
    radioSession: null,
    radioHistory: [],
  });
}

describe("playSongAndContinue", () => {
  beforeEach(reset);

  it("enqueues ONLY the picked song, not the whole result list", () => {
    // This is the bug: picking one result out of a search list used to make the
    // entire list the up-next queue, so the other results silently played for
    // the next half hour.
    usePlayerStore.getState().playSongAndContinue(PICKED);

    const state = usePlayerStore.getState();
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].videoId).toBe("picked");
    expect(state.queue.map((s) => s.videoId)).not.toContain("other1");
    expect(state.queue.map((s) => s.videoId)).not.toContain("other2");
  });

  it("starts the picked song immediately", () => {
    usePlayerStore.getState().playSongAndContinue(PICKED);

    const state = usePlayerStore.getState();
    expect(state.currentSong?.videoId).toBe("picked");
    expect(state.currentIndex).toBe(0);
    expect(state.isPlaying).toBe(true);
    expect(state.currentTime).toBe(0);
  });

  it("seeds the continuation mix with the picked song so it stays related", () => {
    // The continuation must follow what the user actually CHOSE, not the
    // search query — so the mix seed is the picked track.
    usePlayerStore.getState().playSongAndContinue(PICKED);

    const state = usePlayerStore.getState();
    expect(state.isRadio).toBe(true);
    expect(state.radioSeed).toBe("picked");
    // The picked song stays first and playing, so the mix fills in behind it.
    expect(state.queue[0].videoId).toBe("picked");
    expect(state.isPlaying).toBe(true);
  });

  it("does not reset shuffle history into an unrelated mode", () => {
    usePlayerStore.getState().playSongAndContinue(PICKED);
    expect(usePlayerStore.getState().isShuffle).toBe(false);
  });

  it("resets a stale currentTime from the previously playing track", () => {
    usePlayerStore.setState({ currentTime: 187.4, duration: 240 });
    usePlayerStore.getState().playSongAndContinue(PICKED);
    const state = usePlayerStore.getState();
    expect(state.currentTime).toBe(0);
    expect(state.duration).toBe(0);
  });
});

describe("handleTrackEnded pause stickiness", () => {
  beforeEach(reset);

  const seedQueue = () => {
    usePlayerStore.setState({
      queue: [PICKED, OTHER_1, OTHER_2],
      currentIndex: 0,
      currentSong: PICKED,
      isPlaying: true,
      currentTime: 199,
    });
  };

  it("advances the queue while playing", () => {
    seedQueue();
    usePlayerStore.getState().handleTrackEnded();

    const state = usePlayerStore.getState();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.videoId).toBe("other1");
    expect(state.isPlaying).toBe(true);
  });

  it("never advances or resumes while paused", () => {
    // The reported bug: "I paused it and a few seconds later it started
    // playing again." handleTrackEnded is the choke point every late advance
    // path funnels through — a fade-out already in flight when the user hit
    // pause, a near-end timeupdate, the `ended` event, the background
    // watchdog. All of them must be inert once the user has paused.
    seedQueue();
    usePlayerStore.getState().setPlaying(false);

    usePlayerStore.getState().handleTrackEnded();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong?.videoId).toBe("picked");
  });

  it("stays parked at the same track across repeated ended events", () => {
    seedQueue();
    usePlayerStore.getState().setPlaying(false);

    usePlayerStore.getState().handleTrackEnded();
    usePlayerStore.getState().handleTrackEnded();
    usePlayerStore.getState().handleTrackEnded();

    expect(usePlayerStore.getState().currentIndex).toBe(0);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("still honours a deliberate skip while paused", () => {
    // Pausing must only stop AUTOPLAY. Pressing next / a media-key skip is an
    // explicit request and has to keep working from a paused state.
    seedQueue();
    usePlayerStore.getState().setPlaying(false);

    usePlayerStore.getState().next();

    expect(usePlayerStore.getState().currentIndex).toBe(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("keeps replaying a single queued track paused", () => {
    // repeatMode "one" replays via seekTo(0) + playVideo(), which would resume a
    // paused player. It must not.
    usePlayerStore.setState({
      queue: [PICKED],
      currentIndex: 0,
      currentSong: PICKED,
      isPlaying: false,
      repeatMode: "one",
    });

    usePlayerStore.getState().handleTrackEnded();

    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});
