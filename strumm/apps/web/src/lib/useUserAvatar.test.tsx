import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useUserAvatar } from "web/lib/useUserAvatar";

const getAvatarUrl = vi.hoisted(() => vi.fn());
vi.mock("web/lib/media-api", () => ({ getAvatarUrl }));

describe("useUserAvatar", () => {
  beforeEach(() => {
    getAvatarUrl.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns legacy avatar directly without a request", () => {
    const { result } = renderHook(() =>
      useUserAvatar({ avatarMediaId: undefined, avatar: "data:image/png;base64,AA" }),
    );
    expect(result.current).toBe("data:image/png;base64,AA");
    expect(getAvatarUrl).not.toHaveBeenCalled();
  });

  it("falls back to legacy avatar when no mediaId is set", () => {
    const { result } = renderHook(() =>
      useUserAvatar({ avatarMediaId: undefined, avatar: "https://cdn/x.png" }),
    );
    expect(result.current).toBe("https://cdn/x.png");
  });

  it("resolves a B2 avatar via getAvatarUrl and caches it", async () => {
    getAvatarUrl.mockResolvedValueOnce({
      url: "https://b2/avatar?sig=1",
      mediaId: "m1",
      expiresIn: 900,
    });
    const user = { avatarMediaId: "m1", avatar: "" };
    const { result } = renderHook(() => useUserAvatar(user));
    expect(result.current).toBeNull(); // not ready on first render
    await waitFor(() => expect(result.current).toBe("https://b2/avatar?sig=1"));
    expect(getAvatarUrl).toHaveBeenCalledWith("m1");
  });

  it("does not throw when avatar resolution fails (keeps null)", async () => {
    getAvatarUrl.mockRejectedValueOnce(new Error("forbidden"));
    const { result } = renderHook(() =>
      useUserAvatar({ avatarMediaId: "m2", avatar: "data:image/png;base64,BB" }),
    );
    await waitFor(() => expect(getAvatarUrl).toHaveBeenCalledWith("m2"));
    expect(result.current).toBeNull();
  });
});