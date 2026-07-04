import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRadioActions, initialRadioState } from "./radio-actions";
import { Song } from "@strumm/types";

// -----------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------

vi.mock("web/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: {
    getState: () => ({ token: "mock-token" }),
  },
}));

const mockShow = vi.fn();

vi.mock("web/store/useNotificationStore", () => ({
  useNotificationStore: {
    getState: () => ({ show: mockShow }),
  },
}));

import { apiFetch } from "web/lib/api-client";
import { useNotificationStore } from "web/store/useNotificationStore";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function createMockStore(overrides: Record<string, any> = {}) {
  const state: Record<string, any> = {
    ...initialRadioState,
    queue: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    isShuffle: false,
    repeatMode: "none",
    ...overrides,
  };

  const set = vi.fn((partial: Record<string, any>) => {
    Object.assign(state, partial);
  });

  const get = vi.fn(() => state);

  const updateMediaSession = vi.fn();

  const actions = createRadioActions(set, get);

  // Bind actions to the state so they can call each other
  Object.assign(state, actions, { updateMediaSession });

  return { set, get, state, actions };
}

const makeSong = (videoId: string, overrides: Partial<Song> = {}): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artist: `Artist ${videoId}`,
  thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  duration: 200,
  ...overrides,
});

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("initialRadioState", () => {
  it("has all required fields with correct defaults", () => {
    expect(initialRadioState).toEqual({
      isRadio: false,
      radioSeed: null,
      radioSession: null,
      radioHistory: [],
    });
  });
});

describe("startRadio", () => {
  it("populates queue, radio state, and radioHistory", () => {
    const { actions, state, get } = createMockStore();
    const songs = [makeSong("vid1"), makeSong("vid2"), makeSong("vid3")];

    actions.startRadio("seed1", songs);

    expect(state.queue).toEqual(songs);
    expect(state.currentIndex).toBe(0);
    expect(state.isRadio).toBe(true);
    expect(state.radioSeed).toBe("seed1");
    expect(state.radioSession).toMatch(/^radio_seed1_\d+$/);
    expect(state.isShuffle).toBe(false);
    expect(state.repeatMode).toBe("none");

    // radioHistory should contain seed + all song videoIds
    expect(state.radioHistory).toEqual(["seed1", "vid1", "vid2", "vid3"]);

    // Should set current song and play
    expect(state.currentSong).toEqual(songs[0]);
    expect(state.isPlaying).toBe(true);
    expect(state.currentTime).toBe(0);
    expect(get().updateMediaSession).toHaveBeenCalledWith(songs[0]);
  });

  it("handles empty songs array gracefully", () => {
    const { actions, state, get } = createMockStore();
    actions.startRadio("seed1", []);

    expect(state.queue).toEqual([]);
    expect(state.isRadio).toBe(true);
    expect(state.radioHistory).toEqual(["seed1"]);
    // Should NOT set currentSong when no songs
    expect(state.currentSong).toBeNull();
  });

  it("filters out falsy videoIds from radioHistory", () => {
    const { actions, state } = createMockStore();
    const songs = [
      { ...makeSong("vid1"), videoId: "" },
      makeSong("vid2"),
    ] as Song[];

    actions.startRadio("seed1", songs);

    // Empty videoId should be filtered out
    expect(state.radioHistory).toEqual(["seed1", "vid2"]);
  });
});

describe("stopRadio", () => {
  it("clears all radio state", () => {
    const { actions, state } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      radioSession: "radio_seed1_123",
      radioHistory: ["seed1", "vid1", "vid2"],
    });

    actions.stopRadio();

    expect(state.isRadio).toBe(false);
    expect(state.radioSeed).toBeNull();
    expect(state.radioSession).toBeNull();
    expect(state.radioHistory).toEqual([]);
  });
});

describe("setRadioSession", () => {
  it("updates the radio session string", () => {
    const { actions, state } = createMockStore();
    actions.setRadioSession("radio_test_456");
    expect(state.radioSession).toBe("radio_test_456");
  });

  it("handles null session", () => {
    const { actions, state } = createMockStore({
      radioSession: "radio_test_123",
    });
    actions.setRadioSession(null);
    expect(state.radioSession).toBeNull();
  });
});

describe("triggerRadio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing if already playing radio on same seed", async () => {
    const { actions } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
    });

    await actions.triggerRadio("seed1");

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fetches radio tracks and starts radio", async () => {
    const songs = [makeSong("vid1"), makeSong("vid2")];
    vi.mocked(apiFetch).mockResolvedValue({ songs });

    const { actions, state } = createMockStore();

    await actions.triggerRadio("seed1");

    expect(apiFetch).toHaveBeenCalledWith(
      "/radio/seed1?limit=20",
      { token: "mock-token" },
    );
    expect(state.isRadio).toBe(true);
    expect(state.radioSeed).toBe("seed1");
    expect(state.queue).toEqual(songs);
    expect(state.radioHistory).toContain("vid1");
    expect(state.radioHistory).toContain("vid2");
  });

  it("passes radioHistory as exclude param when history exists", async () => {
    const songs = [makeSong("vid3")];
    vi.mocked(apiFetch).mockResolvedValue({ songs });

    const { actions } = createMockStore({
      radioHistory: ["old_vid1", "old_vid2"],
    });

    await actions.triggerRadio("seed2");

    expect(apiFetch).toHaveBeenCalledWith(
      "/radio/seed2?limit=20&exclude=old_vid1,old_vid2",
      { token: "mock-token" },
    );
  });

  it("shows warning notification when no songs returned", async () => {
    mockShow.mockClear();
    vi.mocked(apiFetch).mockResolvedValue({ songs: [] });

    const { actions } = createMockStore();
    await actions.triggerRadio("seed1");

    expect(mockShow).toHaveBeenCalledWith(
      "Couldn't find related tracks for this song.",
      "warning",
    );
  });

  it("shows error notification on API failure", async () => {
    mockShow.mockClear();
    vi.mocked(apiFetch).mockRejectedValue(new Error("Network error"));

    // Suppress console.error in test output
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { actions } = createMockStore();
    await actions.triggerRadio("seed1");

    expect(mockShow).toHaveBeenCalledWith(
      "Couldn't start radio — no related tracks found for this song.",
      "error",
    );
  });
});

describe("fetchMoreRadio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early if radio is not active", async () => {
    const { actions } = createMockStore({ isRadio: false });

    await actions.fetchMoreRadio();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("returns early if no radioSeed", async () => {
    const { actions } = createMockStore({
      isRadio: true,
      radioSeed: null,
    });

    await actions.fetchMoreRadio();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fetches more tracks and appends to queue and radioHistory", async () => {
    const existingQueue = [makeSong("vid1"), makeSong("vid2")];
    const newSongs = [makeSong("vid3"), makeSong("vid4")];
    vi.mocked(apiFetch).mockResolvedValue({ songs: newSongs });

    const { actions, state } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      queue: existingQueue,
      radioHistory: ["seed1", "vid1", "vid2"],
    });

    await actions.fetchMoreRadio();

    expect(apiFetch).toHaveBeenCalledWith(
      "/radio/seed1?limit=20&exclude=seed1,vid1,vid2",
      { token: "mock-token" },
    );
    expect(state.queue).toEqual([...existingQueue, ...newSongs]);
    expect(state.radioHistory).toEqual([
      "seed1",
      "vid1",
      "vid2",
      "vid3",
      "vid4",
    ]);
  });

  it("filters out duplicates from API response", async () => {
    const existingQueue = [makeSong("vid1")];
    // API returns one existing + one new
    const apiResponse = [makeSong("vid1"), makeSong("vid2")];
    vi.mocked(apiFetch).mockResolvedValue({ songs: apiResponse });

    const { actions, state } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      queue: existingQueue,
      radioHistory: ["seed1", "vid1"],
    });

    await actions.fetchMoreRadio();

    // Only the new song should be added
    expect(state.queue).toEqual([...existingQueue, makeSong("vid2")]);
    expect(state.radioHistory).toEqual(["seed1", "vid1", "vid2"]);
  });

  it("warns and does not update when no new tracks available", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(apiFetch).mockResolvedValue({ songs: [makeSong("vid1")] });

    const { actions, state } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      queue: [makeSong("vid1")],
      radioHistory: ["seed1", "vid1"],
    });

    const beforeQueue = [...state.queue];
    const beforeHistory = [...state.radioHistory];

    await actions.fetchMoreRadio();

    expect(warnSpy).toHaveBeenCalledWith("Radio: No new tracks available");
    expect(state.queue).toEqual(beforeQueue);
    expect(state.radioHistory).toEqual(beforeHistory);
  });

  it("shows warning notification on API failure", async () => {
    mockShow.mockClear();
    vi.mocked(apiFetch).mockRejectedValue(new Error("Network error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { actions } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      queue: [makeSong("vid1")],
      radioHistory: ["seed1", "vid1"],
    });

    await actions.fetchMoreRadio();

    expect(mockShow).toHaveBeenCalledWith(
      "Couldn't load more radio tracks.",
      "warning",
    );
  });

  it("passes empty radioHistory without exclude param", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ songs: [makeSong("vid1")] });

    const { actions } = createMockStore({
      isRadio: true,
      radioSeed: "seed1",
      radioHistory: [],
    });

    await actions.fetchMoreRadio();

    expect(apiFetch).toHaveBeenCalledWith(
      "/radio/seed1?limit=20",
      { token: "mock-token" },
    );
  });
});
