/**
 * Listening-time tracker.
 *
 * The backend counts listening time from batches of `POST /play-event` — each
 * with an integer `listenDuration`. This module decides how those seconds are
 * *measured* on the client and how they are delivered, so that a song that was
 * actually played reports its true duration instead of being under/over-counted.
 *
 * Measurement
 * -----------
 * The previous implementation counted one second per `setInterval` tick. Browsers
 * aggressively throttle or suspend timers in background tabs (Chrome intensive
 * throttling) and when the OS suspends the tab (iOS lock/screen-off), so a 4-minute
 * song played with the screen locked registered only ~1 minute. This tracker
 * measures **media position deltas** instead: it subscribes to the player store's
 * `currentTime` (fed by the HTML media element's `timeupdate` events, which fire
 * regardless of timer throttling) and accumulates how far playback actually
 * advanced. No wall-clock ticks are ever counted as listening time.
 *
 * Seeks and stalls are excluded automatically:
 *   - a backward jump (loop / scrub back) resets the baseline and counts nothing,
 *   - a forward jump larger than `maxForwardSeekSeconds` is a seek, not listening,
 *   - a stall at a fixed position accumulates nothing.
 *
 * Delivery
 * --------
 * Seconds are flushed in `flushThresholdSeconds` (30s) batches and partial
 * seconds on pause / song change / hidden tab / unmount. Every event carries a
 * client-generated `eventId` idempotency key, so a retry after a lost response can
 * never double-count (the backend deduplicates on that key). Events that fail to
 * send are retained in a persisted queue and replayed later, newest first, in
 * order; acknowledged events are removed.
 */

export interface ListeningSong {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
}

export interface ListeningEvent {
  eventId: string;
  song: ListeningSong;
  seconds: number;
  createdAt: number;
}

export interface ListeningSnapshot {
  isPlaying: boolean;
  currentSong: ListeningSong | null;
  currentTime: number;
  /** Bumped by the player store every time a seek is issued. */
  seekCount: number;
}

export interface ListeningTrackerOptions {
  /** Register / unregister a listener for player-store changes. */
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ListeningSnapshot;
  /** Persist one event; resolve true only when the backend acknowledged it. */
  send: (event: ListeningEvent) => Promise<boolean>;
  /** localStorage-style queue accessors; return null when storage is unavailable. */
  storageGet?: () => ListeningEvent[] | null;
  storageSet?: (events: ListeningEvent[]) => void;
  createEventId?: () => string;
  now?: () => number;
  /** Seconds of accumulated listening that trigger a network flush. */
  flushThresholdSeconds?: number;
  /** Forward position jumps above this many seconds are treated as seeks. */
  maxForwardSeekSeconds?: number;
  /** Hard ceiling per event (matches the backend's 300s maximum). */
  maxBatchSeconds?: number;
  /** Delay before retrying a failed queue while the player is idle. */
  retryDelayMs?: number;
  /** Cap on how long one send may take; a hung request is treated as a
   * failure and retried (the backend dedupes on eventId, so a late success
   * can never double-count). 0 disables the cap. */
  sendTimeoutMs?: number;
  logger?: (message: string) => void;
}

const QUEUE_STORAGE_KEY = "strumm-pending-listening";
export { QUEUE_STORAGE_KEY };

function defaultCreateEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the non-crypto fallback below
  }
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultNow(): number {
  return Date.now();
}

export class ListeningTracker {
  private readonly options: Required<
    Pick<
      ListeningTrackerOptions,
      | "subscribe"
      | "getSnapshot"
      | "send"
      | "createEventId"
      | "now"
      | "flushThresholdSeconds"
      | "maxForwardSeekSeconds"
      | "maxBatchSeconds"
      | "retryDelayMs"
      | "sendTimeoutMs"
      | "logger"
    >
  > & {
    storageGet?: ListeningTrackerOptions["storageGet"];
    storageSet?: ListeningTrackerOptions["storageSet"];
  };

  private unsubscribe: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private stopped = false;

  /** Song the player is currently (or was last) engaged with. */
  private activeSong: ListeningSong | null = null;
  /** Position baseline used to compute media-position deltas. */
  private baseline = 0;
  private lastSeekCount = 0;
  /** Whole+partial seconds accumulated since the last flush. */
  private accumulated = 0;

  /** In-session queue (acknowledged events leave, failed ones stay). */
  private queue: ListeningEvent[] = [];

  constructor(options: ListeningTrackerOptions) {
    this.options = {
      subscribe: options.subscribe,
      getSnapshot: options.getSnapshot,
      send: options.send,
      createEventId: options.createEventId ?? defaultCreateEventId,
      now: options.now ?? defaultNow,
      flushThresholdSeconds: options.flushThresholdSeconds ?? 30,
      maxForwardSeekSeconds: options.maxForwardSeekSeconds ?? 30,
      maxBatchSeconds: options.maxBatchSeconds ?? 300,
      retryDelayMs: options.retryDelayMs ?? 5_000,
      sendTimeoutMs: options.sendTimeoutMs ?? 10_000,
      logger: options.logger ?? (() => {}),
      storageGet: options.storageGet,
      storageSet: options.storageSet,
    };
  }

  start(): void {
    this.loadPersistedQueue();
    this.unsubscribe = this.options.subscribe(() => this.handleChange());
    this.handleChange(); // establish the baseline immediately
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Flush whatever whole seconds remain for the currently-active song. The
    // drain runs on the event loop, so a pause/page-hide flush still lands.
    this.flushPartial();
    void this.drain();
  }

  /** Push any accumulated whole seconds for the active song into the queue. */
  flushPartial(): void {
    const whole = Math.floor(this.accumulated);
    if (whole < 1 || !this.activeSong) {
      return; // keep the sub-second remainder for the next accumulation
    }
    this.accumulated -= whole;
    this.enqueue(whole, this.activeSong, this.options.now());
  }

  /** Restore the persisted queue after a reload and retry it. */
  private loadPersistedQueue(): void {
    try {
      const stored = this.options.storageGet?.();
      if (stored && Array.isArray(stored) && stored.length > 0) {
        this.queue = [...stored];
        this.options.logger?.(`Listening tracker restored ${stored.length} pending event(s).`);
        void this.drain();
      }
    } catch (error) {
      this.options.logger?.(`Listening tracker could not read pending events: ${String(error)}`);
    }
  }

  private handleChange(): void {
    if (this.stopped) return;
    const snap = this.options.getSnapshot();
    const songKey = snap.currentSong?.videoId ?? null;

    // Paused or no song: close out any accumulated partial seconds.
    if (!snap.isPlaying || !snap.currentSong) {
      this.flushPartial();
      this.baseline = snap.currentTime;
      this.activeSong = snap.currentSong ?? null;
      return;
    }

    // Track change: partial time belongs to the *previous* song.
    if (snap.currentSong.videoId !== this.activeSong?.videoId) {
      this.flushPartial();
      this.activeSong = snap.currentSong;
      this.baseline = snap.currentTime;
      this.lastSeekCount = snap.seekCount;
      return;
    }

    // Explicit seek notification (wrapped seekTo in the player store).
    if (snap.seekCount !== this.lastSeekCount) {
      this.lastSeekCount = snap.seekCount;
      this.baseline = snap.currentTime;
      return;
    }

    const delta = snap.currentTime - this.baseline;
    if (delta < 0) {
      // Backward jump (loop / scrub back): nothing to count, reset the baseline.
      this.baseline = snap.currentTime;
      return;
    }
    if (delta > this.options.maxForwardSeekSeconds) {
      // Unattributed forward skip — counted walls of time jump, not listen.
      this.baseline = snap.currentTime;
      return;
    }

    this.accumulated += delta;
    this.baseline = snap.currentTime;

    // Peel off full batches as they complete.
    const threshold = this.options.flushThresholdSeconds;
    while (this.accumulated >= threshold && this.activeSong) {
      this.accumulated -= threshold;
      this.enqueue(threshold, this.activeSong, this.options.now());
    }
  }

  private enqueue(seconds: number, song: ListeningSong, createdAt: number): void {
    const event: ListeningEvent = {
      eventId: this.options.createEventId(),
      song: { ...song },
      seconds: Math.min(Math.max(1, Math.floor(seconds)), this.options.maxBatchSeconds),
      createdAt,
    };
    this.queue.push(event);
    this.persist();
    void this.drain();
  }

  private persist(): void {
    try {
      this.options.storageSet?.(this.queue.map((e) => ({ ...e, song: { ...e.song } })));
    } catch (error) {
      this.options.logger?.(`Listening tracker could not persist pending events: ${String(error)}`);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue[0];
        let acked = false;
        try {
          acked = await this.sendWithTimeout(event);
        } catch {
          acked = false;
        }
        if (!acked) {
          this.scheduleRetry();
          return;
        }
        this.queue.shift();
        this.persist();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Send one event, bounded by sendTimeoutMs. Without the cap a send whose
   * promise never settles (e.g. a browser fetch that hangs) would leave
   * `draining` true forever, silently wedging the whole queue — every later
   * enqueue would early-return and no retry would ever be scheduled. Treating
   * a timeout as a failed send keeps the event in the queue and schedules a
   * retry; a late success is deduplicated by the backend via the eventId.
   */
  private async sendWithTimeout(event: ListeningEvent): Promise<boolean> {
    const timeoutMs = this.options.sendTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return this.options.send(event);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.options.send(event), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, this.options.retryDelayMs);
  }
}