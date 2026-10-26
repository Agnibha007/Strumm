"use client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

vi.mock("web/lib/api-client", () => ({
  apiFetch: apiFetchMock,
}));

import {
  clearPodcastProgress,
  fetchPodcastProgress,
  savePodcastProgress,
  syncPendingPodcastProgress,
} from "web/lib/podcast-progress";

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

describe("podcast progress persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    setOnline(true);
  });

  afterEach(() => {
    setOnline(true);
  });

  it("stores playback progress locally when offline", async () => {
    setOnline(false);

    await savePodcastProgress("episode-1", 142, 1800);

    expect(apiFetchMock).not.toHaveBeenCalled();
    await expect(fetchPodcastProgress("episode-1")).resolves.toMatchObject({
      positionSeconds: 142,
      durationSeconds: 1800,
    });
  });

  it("syncs locally queued progress when the network returns", async () => {
    setOnline(false);
    await savePodcastProgress("episode-2", 305, 2400);

    setOnline(true);
    apiFetchMock.mockResolvedValue({ episodeId: "episode-2", positionSeconds: 305 });
    await syncPendingPodcastProgress();

    expect(apiFetchMock).toHaveBeenCalledWith("/podcasts/progress/episode-2", {
      method: "PUT",
      body: JSON.stringify({ positionSeconds: 305, durationSeconds: 2400 }),
    });
    await expect(fetchPodcastProgress("episode-2")).resolves.toMatchObject({
      positionSeconds: 305,
      durationSeconds: 2400,
    });
  });

  it("uses server progress on first play and persists it locally", async () => {
    apiFetchMock.mockResolvedValue({
      episodeId: "episode-3",
      positionSeconds: 515,
      durationSeconds: 3600,
      updatedAt: "2026-10-26T12:00:00",
    });

    await expect(fetchPodcastProgress("episode-3")).resolves.toMatchObject({
      positionSeconds: 515,
      durationSeconds: 3600,
    });

    apiFetchMock.mockClear();
    setOnline(false);
    await expect(fetchPodcastProgress("episode-3")).resolves.toMatchObject({
      positionSeconds: 515,
      durationSeconds: 3600,
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("does not wait for the network when resuming a downloaded episode", async () => {
    setOnline(true);
    apiFetchMock.mockImplementation(() => new Promise(() => undefined));

    await expect(fetchPodcastProgress("downloaded-episode", { localOnly: true })).resolves.toMatchObject({
      positionSeconds: 0,
      durationSeconds: 0,
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("persists completion locally so a cleared episode does not resume old progress", async () => {
    setOnline(false);
    await savePodcastProgress("episode-4", 720, 2400);
    await clearPodcastProgress("episode-4");

    await expect(fetchPodcastProgress("episode-4")).resolves.toMatchObject({
      positionSeconds: 0,
      durationSeconds: 2400,
    });
  });
});
