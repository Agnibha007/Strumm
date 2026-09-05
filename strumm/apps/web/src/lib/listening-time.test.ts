import { afterEach, describe, expect, it, vi } from "vitest";
import { ListeningTracker, type ListeningEvent, type ListeningSong } from "./listening-time";

const SONG_A: ListeningSong = { videoId: "v-aaa", title: "Song A", artist: "Artist", thumbnail: "", duration: 300 };
const SONG_B: ListeningSong = { videoId: "v-bbb", title: "Song B", artist: "Artist", thumbnail: "", duration: 240 };

/**
 * Yield to the microtask queue so the tracker's async drain chain can run.
 *
 * Must be *sequential* awaits: Promise.all of pre-created pumps queues every
 * pump ahead of the drain's continuations, so only the first event or two ever
 * gets sent before the assertion runs (the drain chain is starved). Each
 * sequential await lets one drain step interleave with one pump round.
 */
async function flushMicrotasks(times = 500): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Harness {
  listeners: Array<() => void> = [];
  eventTime = 0;
  currentTime = 0;
  isPlaying = true;
  seekCount = 0;
  song: ListeningSong = SONG_A;
  storage: ListeningEvent[] | null = null;
  sent: ListeningEvent[] = [];
  sentRejected: ListeningEvent[] = [];
  private sendImpl: (event: ListeningEvent) => Promise<boolean>;

  constructor(sendImpl?: (event: ListeningEvent) => Promise<boolean>) {
    this.sendImpl =
      sendImpl ??
      ((event) => {
        this.sent.push(event);
        return Promise.resolve(true);
      });
  }

  private getSnapshot = () => ({
    isPlaying: this.isPlaying,
    currentSong: this.song,
    currentTime: this.currentTime,
    seekCount: this.seekCount,
  });

  private subscribe = (listener: () => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  };

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  advance(deltaSec: number): void {
    this.currentTime += deltaSec;
    this.eventTime += deltaSec;
    this.notify();
  }

  announcedSeek(seconds: number): void {
    this.seekCount += 1;
    this.currentTime = seconds;
    this.eventTime += seconds;
    this.notify();
  }

  silentJump(seconds: number): void {
    this.currentTime = seconds;
    this.eventTime += seconds;
    this.notify();
  }

  changeSong(song: ListeningSong, atSeconds = 0): void {
    this.song = song;
    this.currentTime = atSeconds;
    this.eventTime += atSeconds;
    this.notify();
  }

  setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    this.notify();
  }

  createTracker(
    overrides: Partial<{
      flushThresholdSeconds: number;
      maxBatchSeconds: number;
      sendImpl: (event: ListeningEvent) => Promise<boolean>;
    }> = {},
  ): ListeningTracker {
    return new ListeningTracker({
      subscribe: this.subscribe,
      getSnapshot: this.getSnapshot,
      send: overrides.sendImpl ?? this.sendImpl,
      storageGet: () => (this.storage && this.storage.length > 0 ? this.storage : null),
      storageSet: (events) => {
        this.storage = events.map((e) => ({ ...e, song: { ...e.song } }));
      },
      now: () => this.eventTime,
      flushThresholdSeconds: overrides.flushThresholdSeconds ?? 30,
      maxBatchSeconds: overrides.maxBatchSeconds ?? 300,
      retryDelayMs: 100,
    });
  }

  totalSent(): number {
    return this.sent.reduce((sum, event) => sum + event.seconds, 0);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ListeningTracker measurement (position-based, not wall-clock)", () => {
  it("records ~240s for a 4-minute song even though no wall-clock ticks are used", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(119 * 0.25); // 29.75s of playback
    expect(h.sent.length).toBe(0);

    h.advance(0.25); // 30.0s → first flush fires synchronously in the store listener
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].seconds).toBe(30);

    for (let i = 0; i < 839; i += 1) h.advance(0.25); // advance the remaining 209.75s
    h.advance(0.25); // exactly 240.0s
    await flushMicrotasks();

    expect(h.sent.length).toBe(8);
    for (const event of h.sent) expect(event.seconds).toBe(30);
    expect(h.totalSent()).toBe(240);
  });

  it("never counts a stall, a backward jump, or an unannounced forward jump >30s", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(10); // 10s of real listening
    h.advance(0); // a stall fires no store updates
    expect(h.sent.length).toBe(0); // nothing flushed yet
    h.advance(30); // 40s total → 30s chunk
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.totalSent()).toBe(30);

    h.silentJump(1000); // scrubbed forward 960s: the jump itself counts nothing
    h.advance(10); // 10 more real seconds
    h.silentJump(0); // looped back — negative delta, counts nothing
    h.advance(5);
    tracker.flushPartial();

    // 30 (chunk) + 10 (real listening before the forward jump, preserved —
    // matches the hand-computed test) + 10 (post-jump) + 5 (post-loop).
    // Jumps only stop *skipped* seconds from counting; real seconds already
    // accumulated are never dropped.
    expect(h.totalSent()).toBe(30 + 10 + 10 + 5);
  });

  it("treats an announced seek as a seek, not listening time", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(20); // 20s real listening
    h.announcedSeek(80); // user scrub → seekCount bump
    h.advance(10); // 10 more real seconds (80 → 90)
    tracker.flushPartial();

    expect(h.totalSent()).toBe(30);
  });

  it("flushes partial seconds on pause and resumes cleanly", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(25);
    h.setPlaying(false);
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].seconds).toBe(25);

    h.advance(5); // no media can progress while paused
    await flushMicrotasks();
    expect(h.sent.length).toBe(1); // nothing extra counted while paused

    h.setPlaying(true);
    h.advance(5); // 30 → 35
    tracker.flushPartial();
    await flushMicrotasks();
    expect(h.totalSent()).toBe(30);
  });

  it("attributes a mid-song pause flush to the previous song on track change", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(20);
    h.changeSong(SONG_B, 0); // next() → different videoId
    await flushMicrotasks();
    h.advance(15);
    tracker.flushPartial();

    expect(h.sent.length).toBe(2);
    expect(h.sent[0].song.videoId).toBe(SONG_A.videoId);
    expect(h.sent[0].seconds).toBe(20);
    expect(h.sent[1].song.videoId).toBe(SONG_B.videoId);
    expect(h.sent[1].seconds).toBe(15);
  });

  it("keeps sub-second remainders until they reach a whole second", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(0.6);
    tracker.flushPartial();
    expect(h.sent.length).toBe(0);

    h.advance(0.8); // 1.4s accumulated
    tracker.flushPartial();
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].seconds).toBe(1);
  });

  it("matches hand-computed listening time over a scripted session", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(15.5); // 15.5 listened
    h.advance(30); // → 45.5 accumulated → first 30s chunk
    await flushMicrotasks();
    expect(h.totalSent()).toBe(30);

    h.announcedSeek(90); // no count, baseline 90, accumulated preserved (15.5)
    h.advance(30); // → 45.5 accumulated → second 30s chunk
    await flushMicrotasks();
    expect(h.totalSent()).toBe(60);

    h.silentJump(40); // loop-back, counts nothing, accumulated still 15.5
    h.advance(15); // → 30.5 accumulated → third 30s chunk (sub-second remainder kept)
    await flushMicrotasks();
    expect(h.totalSent()).toBe(90);

    h.silentJump(200); // forward scrub without notification
    h.advance(20); // → 20.5 accumulated
    h.setPlaying(false); // partial flush: floor(20.5) = 20
    await flushMicrotasks();
    expect(h.totalSent()).toBe(90 + 20);
  });

  it("matches ideal playback time on a seeded random session (stalls, seeks, jumps)", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();
    const rnd = mulberry32(42);
    let ideal = 0;

    for (let i = 0; i < 3000; i += 1) {
      const r = rnd();
      if (r < 0.6 && h.isPlaying) {
        const d = rnd() * 3;
        h.advance(d);
        ideal += d; // real forward progress measured by the media element
      } else if (r < 0.75) {
        h.announcedSeek(rnd() * 300);
      } else if (r < 0.9) {
        const target = rnd() * 300;
        const delta = target - h.currentTime;
        h.silentJump(target);
        // Mirror the tracker's documented seek heuristic: a forward jump of at
        // most maxForwardSeekSeconds while playing is indistinguishable from
        // buffering catch-up, so it counts as playback; anything larger (or
        // any backward move) is a seek and counts nothing.
        if (h.isPlaying && delta >= 0 && delta <= 30) {
          ideal += delta;
        }
      } else {
        h.setPlaying(!h.isPlaying);
      }
    }
    tracker.flushPartial();
    await flushMicrotasks();

    const sent = h.totalSent();
    expect(sent).toBeLessThanOrEqual(ideal + 1e-9); // never counts phantom time
    expect(Math.abs(sent - Math.floor(ideal))).toBeLessThanOrEqual(1);
  });

  it("caps batches at maxBatchSeconds (defensive against the backend's 300s ceiling)", async () => {
    const h = new Harness();
    const tracker = h.createTracker({ flushThresholdSeconds: 100, maxBatchSeconds: 50 });
    tracker.start();

    for (let i = 0; i < 5; i += 1) h.advance(20); // 100s accumulated → one batch
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].seconds).toBe(50);
    h.advance(20);
    tracker.flushPartial();
    expect(h.totalSent()).toBe(70);
  });
});

describe("ListeningTracker delivery (retries and eventIds)", () => {
  it("gives every outgoing event a fresh, unique eventId", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    for (let i = 0; i < 9; i += 1) h.advance(10); // 90s → three 30s batches
    await flushMicrotasks();
    expect(h.sent.length).toBe(3);
    expect(h.totalSent()).toBe(90);

    const ids = new Set(h.sent.map((e) => e.eventId));
    expect(ids.size).toBe(h.sent.length);
    for (const event of h.sent) {
      expect(event.eventId.length).toBeGreaterThan(0);
      expect(event.createdAt).toBeGreaterThan(0);
    }
  });

  it("retains failed events and replays the SAME eventId across a reload", async () => {
    vi.useFakeTimers();
    let fail = true;
    const h = new Harness((event) => {
      if (fail) {
        h.sentRejected.push(event);
        return Promise.resolve(false);
      }
      h.sent.push(event);
      return Promise.resolve(true);
    });

    const t1 = h.createTracker();
    t1.start();
    h.advance(30);
    await flushMicrotasks();

    expect(h.sentRejected.length).toBe(1);
    expect(h.storage?.length).toBe(1);
    const eventId = h.sentRejected[0].eventId;
    expect(h.sent.length).toBe(0);
    expect(h.totalSent()).toBe(0);

    t1.stop(); // while still failing: nothing new can be acked
    fail = false;

    const t2 = h.createTracker();
    t2.start(); // replays the persisted queue
    await flushMicrotasks();

    expect(h.sent.length).toBe(1);
    expect(h.sent[0].eventId).toBe(eventId); // idempotent replay of the SAME event
    expect(h.sent[0].seconds).toBe(30);
    expect(h.storage ?? []).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.sent.length).toBe(1); // no duplicate send afterwards
  });

  it("removes acknowledged events from the persisted queue (no replay after reload)", async () => {
    const h = new Harness();
    const t1 = h.createTracker();
    t1.start();
    h.advance(30);
    await flushMicrotasks();
    expect(h.sent.length).toBe(1);
    expect(h.storage ?? []).toHaveLength(0);

    const t2 = h.createTracker();
    t2.start();
    await flushMicrotasks();
    expect(h.sent.length).toBe(1); // nothing replayed
  });

  it("stop() flushes remaining partial seconds and sends them", async () => {
    const h = new Harness();
    const tracker = h.createTracker();
    tracker.start();

    h.advance(25);
    tracker.stop();
    await flushMicrotasks();

    expect(h.sent.length).toBe(1);
    expect(h.sent[0].seconds).toBe(25);
    expect(h.sent[0].song.videoId).toBe(SONG_A.videoId);
  });
});