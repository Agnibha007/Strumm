import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshSession = vi.hoisted(() => vi.fn());
const clearLocalSession = vi.hoisted(() => vi.fn());
const markSessionExpired = vi.hoisted(() => vi.fn());
const isAccessTokenExpiredOrAbsent = vi.hoisted(() => vi.fn().mockReturnValue(true));

const mutableState = vi.hoisted(() => ({
  token: "tok-a" as string | null,
  user: { id: "u1" } as { id: string } | null,
  clearLocalSession,
}));

vi.mock("web/store/useAuthStore", () => ({
  useAuthStore: {
    getState: () => mutableState,
  },
  refreshSession,
  isAccessTokenExpiredOrAbsent,
}));

vi.mock("web/lib/session-expiry", () => ({
  markSessionExpired: () => markSessionExpired(),
}));

import { authFetch } from "web/lib/auth-client";

describe("authFetch session handling", () => {
  beforeEach(() => {
    refreshSession.mockReset();
    clearLocalSession.mockReset();
    markSessionExpired.mockReset();
    isAccessTokenExpiredOrAbsent.mockReset();
    isAccessTokenExpiredOrAbsent.mockReturnValue(true);
    mutableState.token = "tok-a";
    mutableState.user = { id: "u1" };
  });

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("passes through non-401 responses untouched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { success: true })));
    const res = await authFetch("/playlists");
    expect(res.status).toBe(200);
    expect(refreshSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("injects the in-memory Bearer token when the caller provided none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await authFetch("/profile");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-a");
    vi.unstubAllGlobals();
  });

  it("silently refreshes and retries once when the access token expired", async () => {
    refreshSession.mockResolvedValue({ ok: true, status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { success: false }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/playlists/1");

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(retryInit.headers).get("Authorization")).toBe("Bearer tok-a");
    expect(res.status).toBe(200);
    expect(markSessionExpired).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("logs the user out with a notice when the refresh is dead and the session is gone", async () => {
    refreshSession.mockResolvedValue({ ok: false, status: 401 });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { success: false }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/playlists/1");

    expect(res.status).toBe(401);
    expect(clearLocalSession).toHaveBeenCalledTimes(1);
    expect(markSessionExpired).toHaveBeenCalledTimes(1);
    expect(markSessionExpired).toHaveBeenCalledBefore(clearLocalSession);
    vi.unstubAllGlobals();
  });

  it("does NOT log the user out on a transient refresh failure", async () => {
    refreshSession.mockResolvedValue({ ok: false, status: null });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { success: false }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/playlists/1");

    expect(res.status).toBe(401);
    expect(markSessionExpired).not.toHaveBeenCalled();
    expect(clearLocalSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does NOT refresh or log out when there was never a session (public route)", async () => {
    mutableState.token = null;
    mutableState.user = null;
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { success: false }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/share/abc");

    expect(res.status).toBe(401);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(markSessionExpired).not.toHaveBeenCalled();
    expect(clearLocalSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does NOT log the user out when the access token is still usable after a dead refresh", async () => {
    refreshSession.mockResolvedValue({ ok: false, status: 401 });
    isAccessTokenExpiredOrAbsent.mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { success: false }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/playlists/1");

    expect(res.status).toBe(401);
    expect(clearLocalSession).not.toHaveBeenCalled();
    expect(markSessionExpired).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});