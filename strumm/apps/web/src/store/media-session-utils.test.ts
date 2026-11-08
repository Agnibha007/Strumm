import { afterEach, describe, expect, it, vi } from "vitest";
import { updateMediaSession } from "./media-session-utils";
import type { Song } from "@strumm/types";

const song = { videoId: "track", title: "Track", artist: "Artist", thumbnail: "" } as Song;

describe("system media transport controls", () => {
  const originalMediaMetadata = globalThis.MediaMetadata;
  let handlers: Record<string, ((details?: any) => void) | null>;

  afterEach(() => {
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: undefined });
    if (originalMediaMetadata) globalThis.MediaMetadata = originalMediaMetadata;
    else Reflect.deleteProperty(globalThis, "MediaMetadata");
  });

  it("routes next and previous system buttons through the queue actions", () => {
    handlers = {};
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: {
        metadata: null,
        setActionHandler: vi.fn((action: string, handler: ((details?: any) => void) | null) => {
          handlers[action] = handler;
        }),
      },
    });
    globalThis.MediaMetadata = class {
      constructor(public data: unknown) {}
    } as unknown as typeof MediaMetadata;

    const next = vi.fn();
    const prev = vi.fn();
    const state = {
      isPlaying: true,
      currentTime: 0,
      duration: 180,
      playerRef: { seekTo: vi.fn(), playVideo: vi.fn(), pauseVideo: vi.fn() },
      setPlaying: vi.fn(),
      setCurrentTime: vi.fn(),
      next,
      prev,
    };

    updateMediaSession(song, () => state);
    handlers.nexttrack?.();
    handlers.previoustrack?.();

    expect(next).toHaveBeenCalledOnce();
    expect(prev).toHaveBeenCalledOnce();
  });

  it("restarts the current item on previous when it is already playing", () => {
    handlers = {};
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: {
        metadata: null,
        setActionHandler: vi.fn((action: string, handler: ((details?: any) => void) | null) => {
          handlers[action] = handler;
        }),
      },
    });
    globalThis.MediaMetadata = class {
      constructor(public data: unknown) {}
    } as unknown as typeof MediaMetadata;

    const seekTo = vi.fn();
    const setCurrentTime = vi.fn();
    const state = {
      isPlaying: true,
      currentTime: 90,
      duration: 180,
      playerRef: { seekTo, playVideo: vi.fn(), pauseVideo: vi.fn() },
      setPlaying: vi.fn(),
      setCurrentTime,
      next: vi.fn(),
      prev: vi.fn(),
    };

    updateMediaSession(song, () => state);
    handlers.previoustrack?.();

    expect(seekTo).toHaveBeenCalledWith(0);
    expect(setCurrentTime).toHaveBeenCalledWith(0);
    expect(state.prev).not.toHaveBeenCalled();
  });
});
