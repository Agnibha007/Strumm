import { createElement } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import AudioEngine from "./AudioEngine";
import { usePlayerStore } from "web/store/usePlayerStore";
import { Song } from "@strumm/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

// Direct-audio resolution is overridden per-suite: by default nothing resolves
// (keeping the iframe-based tests below byte-for-byte identical), and the overlap
// suite points BBBB at a fake stream so the engine can pre-stage and overlap it.
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

      // No crossfade before the final 5s window. (Wait out the 800ms
      // track-change fade-in first so volume settles at the user level.)
      yt.fake.currentTime = 180;
      await flush(1300);
      const before = yt.fake.setVolumeCalls.length;
      expect(yt.fake.setVolumeCalls.at(-1)).toBe(80);

      // Enter the final window — the fade-out must begin (volumes ramp down).
      yt.fake.currentTime = 196;
      await flush(1600);
      const mid = yt.fake.setVolumeCalls.slice(before);
      expect(mid.length).toBeGreaterThan(2);
      expect(Math.min(...mid)).toBeLessThan(80);
      expect(mid.at(-1)).toBeLessThan((mid[0] ?? 80) as number);

      // Let the 5s fade-out complete WITHOUT ever firing YT ENDED (state 0).
      await flush(4500);
      expect(usePlayerStore.getState().currentIndex).toBe(1);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
      expect(yt.fake.loadVideoIds).toContain("BBBB");
    },
  );

  it(
    "fades the next track in from silence after a crossfade advance",
    { timeout: 20_000 },
    async () => {
      await seedAndMount(yt.fake);

      yt.fake.currentTime = 180;
      await flush(1300);

      yt.fake.currentTime = 196;
      await flush(1600);
      await flush(4500);
      expect(usePlayerStore.getState().currentIndex).toBe(1);

      // New track starts playing — simulate YT state=PLAYING for B.
      const pendingStart = yt.fake.setVolumeCalls.length;
      act(() => {
        yt.fake.currentTime = 0;
      });
      await act(async () => {
        yt.fake.events.onStateChange?.({ target: yt.fake, data: 1 });
      });
      expect(
        yt.fake.setVolumeCalls.slice(pendingStart).every((v) => v <= 0),
      ).toBe(true);

      // As B's playback position advances, the ramp must bring volume back up.
      await flush(350);
      const atStart = yt.fake.setVolumeCalls.at(-1) ?? -1;
      yt.fake.currentTime = 1;
      await flush(350);
      yt.fake.currentTime = 2;
      await flush(350);
      const ramped = yt.fake.setVolumeCalls.slice(-3);
      expect(Math.max(...ramped)).toBeGreaterThan(atStart);
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
      await flush(50);
      const preload = createdAudios[1];
      expect(preload).toBeDefined();
      expect(preload.src).toContain("bbbb.mp3");
      expect(preload.paused).toBe(true);
      expect(preload.volume).toBe(0);

      // A settles at the user volume — no overlap before the final 5s window.
      yt.fake.currentTime = 180;
      await flush(1300);
      expect(yt.fake.setVolumeCalls.at(-1)).toBe(80);
      expect(preload.paused).toBe(true);

      // Enter the crossfade window: B must now be AUDIBLE (real overlap with
      // A), ramping from silence toward full volume while A fades to silence.
      yt.fake.currentTime = 196;
      await flush(1600);
      expect(preload.paused).toBe(false);
      const midRamp = preload.volume;
      expect(midRamp).toBeGreaterThan(0);
      expect(midRamp).toBeLessThan(0.8);

      // The fade-out completes → queue advances → B is promoted onto the
      // audible host element WITHOUT a seek/restart and WITHOUT the track-change
      // effect muting it (the overlap already blended it in).
      await flush(5000);
      expect(usePlayerStore.getState().currentIndex).toBe(1);
      expect(usePlayerStore.getState().currentSong?.videoId).toBe("BBBB");
      // The iframe never loaded B — it was handed straight from the staged,
      // already-playing stream (loadVideoIds only ever contained the initial A).
      expect(yt.fake.loadVideoIds).not.toContain("BBBB");
      // The promoted element (the former staging element) is the audible host:
      // still playing, at full volume, no re-mute/ramp after the boundary.
      expect(preload.paused).toBe(false);
      expect(preload.volume).toBeGreaterThan(0.7);
      await flush(300);
      expect(preload.volume).toBeGreaterThan(0.7);
    },
  );
});