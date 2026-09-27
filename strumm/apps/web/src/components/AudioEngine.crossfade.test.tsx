import { createElement } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import AudioEngine from "./AudioEngine";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Song } from "@strumm/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

// Direct-audio resolution is overridden per-suite: by default nothing resolves,
// keeping the iframe-based tests byte-for-byte identical. The overlap suite
// points BBBB at a fake stream so the engine can pre-stage and overlap it; the
// background suite leaves BBBB pending until the test resolves it, so the
// window between the crossfade boundary and the next song's handoff is
// observable.
const { mockGetCachedDirectAudioUrl, mockResolveDirectAudioUrl } = vi.hoisted(() => ({
  mockGetCachedDirectAudioUrl: vi.fn((id: string): string | null => {
    void id;
    return null;
  }),
  mockResolveDirectAudioUrl: vi.fn(async (id: string): Promise<string | null> => {
    void id;
    return null;
  }),
}));
vi.mock("web/lib/direct-audio", () => ({
  getCachedDirectAudioUrl: (id: string) => mockGetCachedDirectAudioUrl(id),
  resolveDirectAudioUrl: (id: string) => mockResolveDirectAudioUrl(id),
}));

type Fake = {
  events: {
    onReady?: (event: { target: Fake }) => void;
    onStateChange?: (event: { target: Fake; data: number }) => void;
  };
  videoId: string;
  currentTime: number;
  duration: number;
  state: number;
  setVolumeCalls: number[];
  playVideoCalls: number;
  loadVideoIds: string[];
  playVideo: () => void;
  pauseVideo: () => void;
  setVolume: (vol: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  loadVideoById: (opts: { videoId: string }) => void;
  cueVideoById: () => void;
  seekTo: () => void;
  setPlaybackRate: () => void;
  setPlaybackQuality: () => void;
  destroy: () => void;
};

function makeFakeYT(): { install: () => void; fake: Fake } {
  const fake: Fake = {
    events: {},
    videoId: "",
    currentTime: 0,
    duration: 200,
    state: -1,
    setVolumeCalls: [],
    playVideoCalls: 0,
    loadVideoIds: [],
    playVideo() {
      this.playVideoCalls += 1;
      this.state = 1;
    },
    pauseVideo() {
      this.state = 2;
    },
    setVolume(vol: number) {
      this.setVolumeCalls.push(vol);
    },
    getCurrentTime() {
      return this.currentTime;
    },
    getDuration() {
      return this.duration;
    },
    getPlayerState() {
      return this.state;
    },
    loadVideoById(opts: { videoId: string }) {
      this.videoId = opts.videoId;
      this.loadVideoIds.push(opts.videoId);
      this.currentTime = 0;
    },
    cueVideoById() {},
    seekTo() {},
    setPlaybackRate() {},
    setPlaybackQuality() {},
    destroy() {},
  };

  class FakeYTPlayer {
    constructor(...args: unknown[]) {
      const config = (args[1] ?? {}) as {
        videoId: string;
        events?: Record<string, (e: never) => void>;
      };
      fake.videoId = config.videoId || "";
      fake.events = (config.events as Fake["events"]) || {};
      return fake as unknown as FakeYTPlayer;
    }
  }

  return {
    install: () => {
      (
        window as unknown as {
          YT: { Player: new (...args: unknown[]) => FakeYTPlayer; PlayerState: Record<string, number> };
        }
      ).YT = {
        Player: FakeYTPlayer,
        PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      };
    },
    fake,
  };
}

function makeSong(id: string, title: string): Song {
  return { videoId: id, title, artist: "test", duration: 200 } as Song;
}

const songA = makeSong("AAAA", "A");
const songB = makeSong("BBBB", "B");

async function seedAndMount(fake: Fake) {
  act(() => {
    usePlayerStore.getState().playSong(songA, [songA, songB]);
  });
  render(createElement(AudioEngine));
  // Player was constructed by the YT-load effect; simulate onReady + auto-play,
  // mirroring a real YT iframe created with autoplay:1.
  await act(async () => {
    fake.events.onReady?.({ target: fake });
  });
  await act(async () => {
    fake.events.onStateChange?.({ target: fake, data: 1 });
  });
}

const flush = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/**
 * Poll until `predicate` holds.
 *
 * These tests run against a real 250ms `setInterval`, so a fixed `flush(400)`
 * is a bet that a tick lands inside 400ms. Under a parallel suite run that bet
 * loses: the suite went red on an otherwise idle machine purely because a 400ms
 * wait missed one 250ms tick. That is a test defect, not a product bug — so poll
 * for the value the engine actually produces instead, and still fail loudly (with
 * the awaited condition named) if it never arrives.
 *
 * Polling rather than faking timers is deliberate: the behaviour under test IS
 * timer-scheduled, and a faked clock would erase the very scheduling these tests
 * exist to check.
 */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let done = false;
    await act(async () => {
      done = predicate();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (done) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms waiting for: ${label}`,
      );
    }
  }
}

/**
 * Advance the fake player's media position and let the engine's progress timer
 * observe it.
 *
 * The crossfade is driven by MEDIA POSITION, not wall-clock time. That is the
 * whole point: hidden tabs throttle `setInterval` to ~1 tick/second (and to 1
 * tick/minute once deeply backgrounded), which stretched the old timer-driven
 * fade out to 15–300 real seconds and was the reported "huge delay between
 * songs". Media position is the one signal that survives throttling, so the
 * tests must drive position and never rely on the clock to complete a fade.
 */
async function seekTo(yt: Fake, seconds: number) {
  const songBefore = usePlayerStore.getState().currentSong?.videoId;
  act(() => {
    yt.currentTime = seconds;
  });
  // The progress timer publishes every position it observes to the store, so
  // that is an exact signal that a tick ran — no sleep-and-hope.
  //
  // At the very end of a track the tick instead *consumes* the position: it
  // advances the queue, which resets currentTime to 0. Waiting for the exact
  // value there would hang forever, so a song change counts as the tick having
  // run too.
  await waitFor(() => {
    const state = usePlayerStore.getState();
    return (
      Math.abs(state.currentTime - seconds) < 0.001 ||
      state.currentSong?.videoId !== songBefore
    );
  }, `the progress timer to act on position ${seconds}`);
}

/**
 * Let the one-off track-change fade-in finish so the volume has settled at the
 * user's level. Only needed when a test asserts a STEADY volume — the crossfade
 * ramps themselves are position-driven and must not be waited on.
 *
 * "The last write is 80" is NOT sufficient: the engine writes the user's full
 * volume when the track is first activated and *then* arms the fade-in, so that
 * condition is briefly true before the ramp has even started. Waiting for the
 * value to have held steady for longer than one progress-tick interval is what
 * actually distinguishes "finished" from "about to begin".
 */
const settle = (yt: Fake, target = 80) => {
  const STABLE_MS = 400; // comfortably more than the 250ms progress tick
  let last: number | undefined;
  let stableSince = 0;
  return waitFor(() => {
    const current = yt.setVolumeCalls.at(-1);
    if (current !== last) {
      last = current;
      stableSince = Date.now();
      return false;
    }
    return current === target && Date.now() - stableSince >= STABLE_MS;
  }, `the track-change fade-in to settle at volume ${target}`);
};

/**
 * Advance a staging <audio> element's playback position and deliver the
 * `timeupdate` a real media pipeline would fire.
 *
 * The incoming track's crossfade ramp is driven by the STAGING element's own
 * media position, not by a `setInterval`. That is deliberate: a timer-driven
 * ramp was pinned near zero off-tab (timers throttled to ~1 tick/second, or 1
 * tick/minute once deeply backgrounded) and then snapped to full volume, which
 * is the "plays suddenly" half of the reported off-tab behaviour. jsdom has no
 * real media pipeline, so the test supplies those events itself.
 */
async function driveStaging(el: HTMLAudioElement, seconds: number) {
  act(() => {
    (el as unknown as { _currentTime: number })._currentTime = seconds;
    el.dispatchEvent(new Event("timeupdate"));
  });
  await flush(50);
}

describe("AudioEngine foreground iframe crossfade", () => {
  let yt: ReturnType<typeof makeFakeYT>;

  beforeEach(() => {
    yt = makeFakeYT();
    yt.install();
    act(() => {
      usePlayerStore.setState({
        currentSong: null,
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        shufflePlayedIds: [],
      });
    });
  });

  it(
    "starts the crossfade fade-out near the end and advances via the fade (no ENDED event)",
    { timeout: 20_000 },
    async () => {
      await seedAndMount(yt.fake);

      // No crossfade before the final 5s window. (Wait out the track-change
      // fade-in first so volume settles at the user level.)
      await settle(yt.fake);
      await seekTo(yt.fake, 180);
      const before = yt.fake.setVolumeCalls.length;
      expect(yt.fake.setVolumeCalls.at(-1)).toBe(80);

      // Enter the final window — the fade-out must begin, ramping DOWN as the
      // track's own position advances. (The first tick in the window only arms
      // the fade; the write comes from the tick after it, so wait for it rather
      // than assuming the arming tick wrote something.)
      await seekTo(yt.fake, 196);
      await waitFor(
        () => yt.fake.setVolumeCalls.length > before,
        "the crossfade fade-out to issue its first volume write",
      );
      const atWindowStart = yt.fake.setVolumeCalls.slice(before);
      expect(atWindowStart.length).toBeGreaterThan(0);
      expect(Math.min(...atWindowStart)).toBeLessThan(80);

      await seekTo(yt.fake, 199.5);
      const late = yt.fake.setVolumeCalls.slice(before);
      expect(Math.min(...late)).toBeLessThan(Math.min(...atWindowStart));

      // Reaching the end of the track advances the queue WITHOUT ever firing YT
      // ENDED (state 0) — and does so on the tick where the position arrives,
      // not after a wall-clock timer.
      await seekTo(yt.fake, 200);
      // The store advance is synchronous inside the tick; loading B onto the
      // iframe is a React effect, so wait for that rather than assuming it has
      // run by the time the assertion executes.
      await waitFor(
        () => yt.fake.loadVideoIds.includes("BBBB"),
        "the next track to be loaded onto the iframe",
      );
      expect(usePlayerStore.getState().currentIndex).toBe(1);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
      expect(yt.fake.state).not.toBe(0);
    },
  );

  it(
    "fades the next track in from silence after a crossfade advance",
    { timeout: 20_000 },
    async () => {
      await seedAndMount(yt.fake);

      await seekTo(yt.fake, 180);
      await seekTo(yt.fake, 196);
      await seekTo(yt.fake, 200);
      expect(usePlayerStore.getState().currentIndex).toBe(1);

      // New track starts playing — simulate YT state=PLAYING for B.
      const pendingStart = yt.fake.setVolumeCalls.length;
      act(() => {
        yt.fake.currentTime = 0;
      });
      await act(async () => {
        yt.fake.events.onStateChange?.({ target: yt.fake, data: 1 });
      });
      // Wait for the fade-in's first write, so "every write so far is at or
      // below silence" is a statement about observed writes rather than about
      // a window that happened to be short enough.
      await waitFor(
        () => yt.fake.setVolumeCalls.length > pendingStart,
        "the fresh track to receive its first volume write",
      );
      expect(
        yt.fake.setVolumeCalls.slice(pendingStart).every((v) => v <= 0),
      ).toBe(true);

      // As B's playback position advances, the ramp must bring volume back up.
      const atStart = yt.fake.setVolumeCalls.at(-1) ?? -1;
      await seekTo(yt.fake, 1);
      const atOneSecond = yt.fake.setVolumeCalls.at(-1) ?? -1;
      expect(atOneSecond).toBeGreaterThan(atStart);
      await seekTo(yt.fake, 2.5);
      const ramped = yt.fake.setVolumeCalls.at(-1) ?? -1;
      expect(ramped).toBeGreaterThan(atOneSecond);
      // Converges on the user's level rather than overshooting it.
      expect(ramped).toBe(80);
    },
  );

  it(
    "does not burst the new track in at full volume when it starts",
    { timeout: 20_000 },
    async () => {
      // Regression: activating a stream used to hard-set it to FULL volume while
      // the position-driven fade-in was already armed for it and computing ~0.
      // Two writers, one element, opposite answers — audible as "plays suddenly,
      // then fades out, then fades back in".
      await seedAndMount(yt.fake);

      await seekTo(yt.fake, 196);
      await seekTo(yt.fake, 200);
      expect(usePlayerStore.getState().currentIndex).toBe(1);

      const afterAdvance = yt.fake.setVolumeCalls.length;
      act(() => {
        yt.fake.currentTime = 0;
      });
      await act(async () => {
        yt.fake.events.onStateChange?.({ target: yt.fake, data: 1 });
      });
      // Wait for at least one write so the assertion below is about real
      // traffic. Without this, a slow machine could produce zero writes and the
      // test would pass vacuously.
      await waitFor(
        () => yt.fake.setVolumeCalls.length > afterAdvance,
        "the fresh track to receive its first volume write",
      );

      // Nothing may have written a full-volume spike into the fresh track.
      const writes = yt.fake.setVolumeCalls.slice(afterAdvance);
      expect(Math.max(...writes)).toBeLessThan(80);
    },
  );

  it(
    "an explicit pause is sticky and never auto-advances",
    { timeout: 20_000 },
    async () => {
      await seedAndMount(yt.fake);
      await seekTo(yt.fake, 180);

      // Pause the way a user does.
      act(() => {
        usePlayerStore.getState().setPlaying(false);
      });

      // Park the track at the very end of its crossfade window — the exact
      // moment the fade would normally complete and call next().
      await seekTo(yt.fake, 196);
      await seekTo(yt.fake, 200);

      // These two waits are deliberately a fixed observation window, not a
      // poll: the assertion is that NOTHING happens, so there is no positive
      // signal to wait for. Sized well above the 250ms tick plus the 5s fade
      // window's remaining ramp, so a loaded machine cannot pass by being slow.
      await flush(1500);
      await flush(1500);

      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(usePlayerStore.getState().currentIndex).toBe(0);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("AAAA");
    },
  );
});

describe("AudioEngine true-overlap crossfade", () => {
  let yt: ReturnType<typeof makeFakeYT>;
  const createdAudios: HTMLAudioElement[] = [];

  beforeEach(() => {
    yt = makeFakeYT();
    yt.install();
    act(() => {
      usePlayerStore.setState({
        currentSong: null,
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        shufflePlayedIds: [],
      });
    });

    // Point the next track (BBBB) at a fake direct stream; the current track
    // (AAAA) stays on the iframe, mirroring "stream not yet extracted".
    mockGetCachedDirectAudioUrl.mockImplementation((id: string) =>
      id === "BBBB" ? "https://direct.example/bbbb.mp3" : null,
    );
    mockResolveDirectAudioUrl.mockImplementation(async (id: string) =>
      id === "BBBB" ? "https://direct.example/bbbb.mp3" : null,
    );

    // jsdom's <audio> is a non-functional stub: give play/pause/paused/volume/
    // readyState spec-shaped behavior and track every element created, so the
    // overlap (staging element audible while A fades) can be asserted. The
    // engine creates exactly two elements: htmlAudioRef then preloadAudioRef.
    createdAudios.length = 0;
    const OriginalAudio = window.Audio;
    (window as unknown as { Audio: typeof Audio }).Audio = function (
      this: unknown,
    ) {
      const el = new OriginalAudio();
      (el as unknown as Record<string, unknown>)._volume = 0;
      (el as unknown as Record<string, unknown>)._volumeLog = [];
      (el as unknown as Record<string, unknown>)._readyState = 2; // HAVE_CURRENT_DATA
      createdAudios.push(el);
      return el;
    } as unknown as typeof Audio;

    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: true,
      get() {
        return (this as unknown as Record<string, unknown>)._volume ?? 1.0;
      },
      set(v: number) {
        (this as unknown as Record<string, unknown>)._volume = v;
        const log = (this as unknown as Record<string, unknown>)._volumeLog;
        if (Array.isArray(log)) (log as number[]).push(Math.round(v * 100));
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return !(this as unknown as Record<string, unknown>)._playing;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get() {
        return (this as unknown as Record<string, unknown>)._readyState ?? 0;
      },
    });
    // jsdom's `currentTime` is inert, which would freeze the position-driven
    // crossfade ramps at 0 forever. Back it with a plain field so tests can
    // advance the position the way real playback does.
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        return (this as unknown as Record<string, unknown>)._currentTime ?? 0;
      },
      set(v: number) {
        (this as unknown as Record<string, unknown>)._currentTime = v;
      },
    });
    HTMLMediaElement.prototype.play = function (this: unknown): Promise<void> {
      (this as unknown as Record<string, unknown>)._playing = true;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function (this: unknown): void {
      (this as unknown as Record<string, unknown>)._playing = false;
    };
  });

  afterEach(() => {
    mockGetCachedDirectAudioUrl.mockReset().mockImplementation(() => null);
    mockResolveDirectAudioUrl.mockReset().mockImplementation(async () => null);
  });

  it(
    "blends the incoming track on the staging element while the outgoing fades, then promotes it seamlessly",
    { timeout: 25_000 },
    async () => {
      await seedAndMount(yt.fake);

      // The preload effect stages the predicted next track (BBBB) — buffered
      // but (crucially) NOT audible yet.
      await waitFor(
        () => createdAudios[1]?.src.includes("bbbb.mp3") ?? false,
        "the predicted next track to be staged on the preload element",
      );
      const preload = createdAudios[1];
      expect(preload).toBeDefined();
      expect(preload.src).toContain("bbbb.mp3");
      expect(preload.paused).toBe(true);
      expect(preload.volume).toBe(0);

      // A settles at the user volume — no overlap before the final 5s window.
      await settle(yt.fake);
      await seekTo(yt.fake, 180);
      expect(yt.fake.setVolumeCalls.at(-1)).toBe(80);
      expect(preload.paused).toBe(true);
      expect(preload.volume).toBe(0);

      // Enter the crossfade window: B must now be AUDIBLE (real overlap with
      // A), ramping from silence toward full volume while A fades to silence.
      // The ramp is driven by the staging element's own position, so drive it.
      await seekTo(yt.fake, 196);
      expect(preload.paused).toBe(false);
      expect(preload.volume).toBe(0);
      await driveStaging(preload, 2);
      const midRamp = preload.volume;
      expect(midRamp).toBeGreaterThan(0);
      expect(midRamp).toBeLessThan(0.8);

      // The fade-out completes → queue advances → B is promoted onto the
      // audible host element WITHOUT a seek/restart and WITHOUT the track-change
      // effect muting it (the overlap already blended it in).
      await driveStaging(preload, 5);
      await seekTo(yt.fake, 200);
      expect(usePlayerStore.getState().currentIndex).toBe(1);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
      // The iframe never loaded B — it was handed straight from the staged,
      // already-playing stream (loadVideoIds only ever contained the initial A).
      expect(yt.fake.loadVideoIds).not.toContain("BBBB");
      // The promoted element (the former staging element) is the audible host:
      // still playing, at full volume, no re-mute/ramp after the boundary.
      await waitFor(
        () => preload.volume > 0.7,
        "the promoted element to reach the user's volume",
      );
      expect(preload.paused).toBe(false);
      // The "no re-mute after the handoff" check is a negative assertion, so a
      // fixed window past the 250ms tick is the correct form here.
      await flush(600);
      expect(preload.volume).toBeGreaterThan(0.7);
    },
  );
});

describe("AudioEngine background crossfade (iframe surface)", () => {
  let yt: ReturnType<typeof makeFakeYT>;
  let pendingB: Promise<string | null>;
  let resolveB: (url: string | null) => void;

  beforeEach(() => {
    yt = makeFakeYT();
    yt.install();
    act(() => {
      usePlayerStore.setState({
        currentSong: null,
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        shufflePlayedIds: [],
      });
    });

    // Nothing resolves for A, so after the page is backgrounded it stays on the
    // iframe surface (the direct-stream failure fallback). B's URL is left
    // pending for the test to resolve later, exposing the window between the
    // crossfade boundary and the next song's activation.
    mockGetCachedDirectAudioUrl.mockImplementation(() => null);
    pendingB = new Promise<string | null>((r) => {
      resolveB = r;
    });
    mockResolveDirectAudioUrl.mockImplementation(async (id: string) =>
      id === "BBBB" ? pendingB : null,
    );
  });

  afterEach(() => {
    mockGetCachedDirectAudioUrl.mockReset().mockImplementation(() => null);
    mockResolveDirectAudioUrl.mockReset().mockImplementation(async () => null);
  });

  it(
    "pauses the old song on the iframe the instant the background crossfade completes",
    { timeout: 20_000 },
    async () => {
      await seedAndMount(yt.fake);

      // Background the page: A has no direct stream, so the iframe remains the
      // audible surface and the host <audio> only runs the silent loop.
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      // The background position is still published to the store by the same
      // progress timer, so wait for the loop to prove it is live rather than
      // sleeping a guessed duration.
      await seekTo(yt.fake, 1);

      // Crossfade window: the background fade-out — driven from the YouTube
      // progress timer (not setInterval), mirroring a throttled hidden tab —
      // ramps the iframe volume down toward silence.
      await seekTo(yt.fake, 196);
      await seekTo(yt.fake, 199);
      const faded = yt.fake.setVolumeCalls.slice(-3);
      expect(Math.min(...faded)).toBeLessThan(80);

      // The track reaches its end: the queue advances, and the stale iframe
      // must be PAUSED at the boundary. B's direct URL is still resolving — if
      // the old song were left PLAYING here, it would stay audible for the
      // whole resolution window and then cut abruptly when B activates.
      await seekTo(yt.fake, 200);
      expect(usePlayerStore.getState().currentIndex).toBe(1);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
      expect(yt.fake.state).toBe(2);
      expect(yt.fake.loadVideoIds).not.toContain("BBBB");

      // B's direct stream arrives: playback hands off to the host <audio>
      // element; the iframe stays parked on the old paused video.
      //
      // The host element is a `new Audio()` with no DOM handle, so the handoff
      // has no positive signal the test can poll — and the assertion here is
      // that the iframe does NOT resume, which is a negative one. Fixed window
      // is therefore correct, sized well past the 250ms tick.
      act(() => {
        resolveB("https://direct.example/bbbb.mp3");
      });
      await flush(1500);
      expect(yt.fake.state).toBe(2);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
    },
  );
});
