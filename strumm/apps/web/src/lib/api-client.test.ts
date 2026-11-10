import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshSession = vi.hoisted(() => vi.fn());
const clearLocalSession = vi.hoisted(() => vi.fn());
const isAccessTokenExpiredOrAbsent = vi.hoisted(() => vi.fn());
const markSessionExpired = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  token: "expired-token" as string | null,
  user: { id: "user-1" } as { id: string } | null,
  silentRefresh: vi.fn(),
  clearLocalSession,
}));

vi.mock("web/lib/api", () => ({ apiUrl: (path: string) => path }));
vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: { getState: () => state },
  refreshSession,
  isAccessTokenExpiredOrAbsent,
}));
vi.mock("web/lib/session-expiry", () => ({ markSessionExpired }));

import { apiFetch, ApiError } from "web/lib/api-client";

describe("apiFetch session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.token = "expired-token";
    state.user = { id: "user-1" };
    isAccessTokenExpiredOrAbsent.mockReturnValue(true);
  });

  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("clears the local session when an expired access token has a rejected refresh token", async () => {
    refreshSession.mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { success: false })));

    await expect(apiFetch("/profile")).rejects.toBeInstanceOf(ApiError);

    expect(markSessionExpired).toHaveBeenCalledOnce();
    expect(clearLocalSession).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("does not clear the session after a transient refresh failure", async () => {
    refreshSession.mockResolvedValue({ ok: false, status: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { success: false })));

    await expect(apiFetch("/profile")).rejects.toBeInstanceOf(ApiError);

    expect(clearLocalSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not refresh or log out a user on a public request", async () => {
    state.token = null;
    state.user = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { success: false })));

    await expect(apiFetch("/public-resource")).rejects.toBeInstanceOf(ApiError);

    expect(refreshSession).not.toHaveBeenCalled();
    expect(clearLocalSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
