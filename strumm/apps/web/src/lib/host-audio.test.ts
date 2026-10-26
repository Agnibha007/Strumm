import { afterEach, describe, expect, it, vi } from "vitest";
import { playHostAudioUrl, registerHostAudioElement } from "./host-audio";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host audio playback", () => {
  it("uses the registered audio element to play a prepared Blob URL", async () => {
    const audio = {
      src: "",
      pause: vi.fn(),
      load: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLAudioElement;
    const release = registerHostAudioElement(audio);

    await playHostAudioUrl("blob:strumm-episode");

    expect(audio.src).toBe("blob:strumm-episode");
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    release();
  });

  it("does not reload the same source when resuming playback", async () => {
    const audio = {
      src: "blob:strumm-episode",
      pause: vi.fn(),
      load: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLAudioElement;
    const release = registerHostAudioElement(audio);

    await playHostAudioUrl("blob:strumm-episode");

    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.load).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledOnce();
    release();
  });
});
