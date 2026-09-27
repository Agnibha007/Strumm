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
    pendingNextIndex: null,
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

describe("committed next track (crossfade prediction)", () => {
  beforeEach(reset);

  const seedQueue = () => {
    usePlayerStore.setState({
      queue: [PICKED, OTHER_1, OTHER_2],
      currentIndex: 0,
      currentSong: PICKED,
      isPlaying: true,
    });
  };

  it("lands the advance on the committed track, not a fresh pick", () => {
    // A real crossfade has to name the incoming track before it plays it, so it
    // can pre-buffer and ramp that exact stream. If the queue then re-resolved
    // instead of honouring that name, the track the listener heard fading in
    // would not be the track that plays — which is why the crossfade used to be
    // disabled outright under shuffle.
    seedQueue();
    usePlayerStore.setState({ isShuffle: true, shufflePlayedIds: ["picked"] });
    // Whatever shuffle decides, the engine writes the decision down first.
    usePlayerStore.getState().setPendingNextIndex(2);

    usePlayerStore.getState().handleTrackEnded();

    expect(usePlayerStore.getState().currentIndex).toBe(2);
    expect(usePlayerStore.getState().currentSong?.videoId).toBe("other2");
  });

  it("is consumed exactly once — the next advance resolves normally", () => {
    // A four-track queue so the plain sequential step is visible after the
    // committed (non-sequential) jump.
    const fourth = song("other3", "Other Three");
    usePlayerStore.setState({
      queue: [PICKED, OTHER_1, OTHER_2, fourth],
      currentIndex: 0,
      currentSong: PICKED,
      isPlaying: true,
    });

    usePlayerStore.getState().setPendingNextIndex(2);
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.videoId).toBe("other2");
    // Consumed: a second advance must not bounce back to the same slot.
    expect(usePlayerStore.getState().pendingNextIndex).toBeNull();

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.videoId).toBe("other3");
  });

  it("is honoured by a deliberate skip too, so the two can never disagree", () => {
    // Both advance paths must read the same commitment, or a media-key skip at
    // the crossfade boundary would land somewhere the pre-buffer never fetched.
    seedQueue();
    usePlayerStore.getState().setPendingNextIndex(2);

    usePlayerStore.getState().next();

    expect(usePlayerStore.getState().currentIndex).toBe(2);
  });

  it("refuses a commitment that is out of range, or the current slot", () => {
    // A stale or nonsense commitment would otherwise be silently ignored here
    // and then hijack an unrelated advance.
    seedQueue();
    const store = usePlayerStore.getState();

    store.setPendingNextIndex(99);
    expect(usePlayerStore.getState().pendingNextIndex).toBeNull();

    store.setPendingNextIndex(-1);
    expect(usePlayerStore.getState().pendingNextIndex).toBeNull();

    store.setPendingNextIndex(1.5);
    expect(usePlayerStore.getState().pendingNextIndex).toBeNull();

    store.setPendingNextIndex(0);
    expect(usePlayerStore.getState().pendingNextIndex).toBeNull();

    store.setPendingNextIndex(2);
    expect(usePlayerStore.getState().pendingNextIndex).toBe(2);
  });

  it("is retired by anything that changes which track plays next", () => {
    // The commitment is only meaningful for the transition that made it. If it
    // outlived that, some later advance would land on a track the listener never
    // heard coming.
    const retired: Array<[string, () => void]> = [
      ["shuffle on", () => usePlayerStore.getState().setShuffle(true)],
      ["shuffle off", () => usePlayerStore.getState().setShuffle(false)],
      ["repeat mode", () => usePlayerStore.getState().setRepeatMode("all")],
      ["queue rewrite", () => usePlayerStore.getState().setQueue([PICKED, OTHER_1])],
      ["playing a song", () => usePlayerStore.getState().playSong(OTHER_2)],
      [
        "play-and-continue",
        () => usePlayerStore.getState().playSongAndContinue(OTHER_2),
      ],
    ];

    for (const [label, mutate] of retired) {
      seedQueue();
      usePlayerStore.getState().setPendingNextIndex(2);
      expect(usePlayerStore.getState().pendingNextIndex).toBe(2);

      mutate();

      expect(usePlayerStore.getState().pendingNextIndex, label).toBeNull();
    }
  });

  it("survives adding to the queue, because the committed slot still exists", () => {
    // Appending never renumbers existing slots, so a valid commitment stays
    // valid — clearing it here would needlessly break the crossfade every time
    // the radio mix tops the queue up behind the current track.
    seedQueue();
    usePlayerStore.getState().setPendingNextIndex(2);

    usePlayerStore.getState().addToQueue(song("added"));

    expect(usePlayerStore.getState().pendingNextIndex).toBe(2);
  });
});
