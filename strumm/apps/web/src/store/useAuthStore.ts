import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiFetch, ApiError } from "web/lib/api-client";
import { apiUrl } from "web/lib/api";
import { consumeSessionExpiredNotice } from "web/lib/session-expiry";

// ---------------------------------------------------------------------------
// Typed global window extensions for auth timers and visibility handler
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __strummVisibilityHandler?: (() => Promise<void>) | null;
  }
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  login: (token: string, user: User, refreshToken?: string) => void;
  logout: () => void;
  fetchProfile: () => Promise<boolean>;
  silentRefresh: () => Promise<boolean>;
  /** Drop local session state without revoking the server session or clearing cookies. */
  clearLocalSession: () => void;
}

interface RefreshResult {
  ok: boolean;
  status: number | null;
}

// Refresh calls share one in-flight request and Web Locks serialize them across
// tabs. The opaque refresh token remains stable while the server extends its
// expiry on use, avoiding concurrent rotation races that could revoke active sessions.
let _refreshPromise: Promise<RefreshResult> | null = null;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      
      setUser: (user) => set({ user }),
      setToken: (token) => set({ token }),
      
      login: (token, user, refreshToken) => {
        consumeSessionExpiredNotice();
        set({ token, user, refreshToken: refreshToken || null });
      },
      
      logout: () => {
        const { refreshToken } = get();

        // Revoke session on the server before clearing local state.
        // The httpOnly access_token/refresh_token cookies are cleared by the
        // backend; credentials must be included for the Set-Cookie to apply.
        if (typeof window !== "undefined") {
          fetch(apiUrl("/auth/logout"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ refreshToken }),
          }).catch(() => {
            // Fire-and-forget: don't block logout if the request fails
          });
        }

        set({ token: null, user: null, refreshToken: null });
        teardownSessionListeners();
      },

      // Clears only the local state. Unlike logout(), this does NOT revoke the
      // server session or delete the httpOnly cookies, so a later page load can
      // still restore the session via refreshSession once the API is reachable.
      clearLocalSession: () => {
        set({ token: null, user: null, refreshToken: null });
        teardownSessionListeners();
      },

      silentRefresh: async () => {
        const result = await refreshSession();
        return result.ok;
      },

      fetchProfile: async () => {
        let { token } = get();

        // On reload the token lives only in memory (it is never persisted), so
        // restore the session from the httpOnly cookies before fetching.
        if (!token) {
          const result = await refreshSession();
          if (!result.ok) {
            // Non-destructive: a dead/transient refresh must not revoke the
            // server session or wipe the cookies. Only drop local state when
            // the access token is truly unusable AND the refresh was rejected
            // with 401 (the session is genuinely gone). Anything else (network
            // error or cold start keeps the session so the
            // background retry in initializeAuth can recover it.
            if (isAccessTokenExpiredOrAbsent(get().token) && result.status === 401) {
              get().clearLocalSession();
            }
            return false;
          }
          token = get().token;
        }

        try {
          const data = await apiFetch<any>("/profile", { token });
          set({ user: data });
          return true;
        } catch (e) {
          // If 401, try silent refresh first
          if (e instanceof ApiError && e.status === 401) {
            const result = await refreshSession();
            if (result.ok) {
              // Retry fetchProfile with new token
              try {
                const data = await apiFetch<any>("/profile", { token: get().token });
                set({ user: data });
                return true;
              } catch (err) {
                // A transient failure re-fetching the profile (e.g. cold start
                // right after the refresh) must NOT wipe the session — only a
                // confirmed dead access token may.
                if (
                  err instanceof ApiError &&
                  err.status === 401 &&
                  isAccessTokenExpiredOrAbsent(get().token)
                ) {
                  get().clearLocalSession();
                }
                return false;
              }
            }
            if (isAccessTokenExpiredOrAbsent(get().token) && result.status === 401) {
              get().clearLocalSession();
            }
            return false;
          }
          console.warn("Unable to sync profile offline. Using cached user session.");
          return true;
        }
      }
    }),
    {
      name: "strumm-auth-cache",
      version: 1,
      // Tokens are only ever kept in memory. On reload they are restored via the
      // httpOnly cookies (see initializeAuth). Persisting them to localStorage
      // would expose them to any XSS.
      partialize: (state) => ({
        user: state.user,
      }),
      migrate: (persisted: unknown) => {
        // Drop any legacy token fields that were persisted under version 0.
        const legacy = (persisted ?? {}) as Record<string, unknown>;
        return {
          user: (legacy.user as User | null) ?? null,
        };
      },
    }
  )
);

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

// Returns true only when the access token is absent or expired.
function isAccessTokenExpiredOrAbsent(token: string | null): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  const expiresAt = Number(payload.exp) * 1000;
  return expiresAt - Date.now() <= 0;
}
export { isAccessTokenExpiredOrAbsent };

const REFRESH_BUFFER_MS = 10 * 60 * 1000;
let _refreshing = false;

// Clears the visibility listener without touching the server session or cookies.
function teardownSessionListeners() {
  if (typeof window === "undefined") return;
  if (window.__strummVisibilityHandler) {
    document.removeEventListener("visibilitychange", window.__strummVisibilityHandler);
    window.__strummVisibilityHandler = null;
  }
}

// Serialize refreshes across browser tabs via the Web Locks API so the rotation
// can't race even when several tabs restore the session at once. Falls back to
// a no-op when the API is unavailable (older browsers).
function acquireRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    return navigator.locks.request(
      "strumm-session-refresh",
      { mode: "exclusive" },
      () => task()
    ) as Promise<T>;
  }
  return task();
}

// Single-flight wrapper around performRefresh. Every caller shares one in-flight request.
function refreshSession(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = acquireRefreshLock(performRefresh).finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}
export { refreshSession };

// Single refresh attempt. The server keeps the opaque refresh token stable and
// moves the session's idle deadline forward. Returns the status for error handling.
async function performRefresh(): Promise<RefreshResult> {
  const { refreshToken } = useAuthStore.getState();

  // If we have an in-memory refresh token (e.g. after a Google sign-in through
  // NextAuth), send it in the body as a fallback. Otherwise the backend reads
  // the httpOnly refresh_token cookie automatically.
  const body = refreshToken ? JSON.stringify({ refreshToken }) : "{}";

  try {
    const res = await fetch(apiUrl("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body,
    });

    let json: { success?: boolean; data?: { token?: string; refreshToken?: string; user?: User }; error?: string } | null = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON body (e.g. a gateway error page) — treat as a failed refresh.
    }

    // The httpOnly cookie is authoritative if an explicit refresh token was
    // supplied by an older session or an OAuth initialization path.
    if (!res.ok && res.status === 401 && refreshToken) {
      useAuthStore.setState({ refreshToken: null });
      await new Promise((r) => setTimeout(r, 250));
      return performRefresh();
    }

    if (res.ok && json?.success && json.data?.token) {
      useAuthStore.setState({
        token: json.data.token,
        user: json.data.user ?? useAuthStore.getState().user,
        refreshToken: json.data.refreshToken || refreshToken,
      });
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

// Bounded retry for transient failures (deploy restarts, HF Spaces cold start).
// Never destroys the server session or the cookies on transient errors; only a
// 401 with a truly unusable access token ends the session.
async function retryRefreshInBackground() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
    await new Promise((resolve) => setTimeout(resolve, backoff));

    if (useAuthStore.getState().token) return; // recovered elsewhere
    const result = await refreshSession();
    if (result.ok) return;
    if (
      result.status === 401 &&
      isAccessTokenExpiredOrAbsent(useAuthStore.getState().token)
    ) {
      useAuthStore.getState().clearLocalSession();
      return;
    }
  }
}

/**
 * Listen for the user returning to the tab (e.g., phone in pocket, then picked up).
 * Browsers throttle timers in background tabs, so this ensures we refresh promptly
 * when the user comes back, before the token can expire.
 */
function setupVisibilityRefresh() {
  if (typeof window === "undefined") return;

  const handler = async () => {
    if (document.visibilityState !== "visible") return;
    if (_refreshing) return; // skip if already refreshing

    const { token } = useAuthStore.getState();
    if (!token) return;

    // Decode the JWT to check remaining time without a network call
    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return;
    const expiresAt = Number(payload.exp) * 1000;
    const remaining = expiresAt - Date.now();

    // If less than the refresh buffer remains, refresh proactively
    if (remaining < REFRESH_BUFFER_MS) {
      _refreshing = true;
      const { silentRefresh } = useAuthStore.getState();
      await silentRefresh();
      _refreshing = false;
    }
  };

  document.addEventListener("visibilitychange", handler);
  // Store reference for cleanup on logout
  window.__strummVisibilityHandler = handler;
}

// Restore the session on page load. Subsequent refreshes happen when an
// authenticated request needs them or the user returns to an expired access token.
// This lets the server's idle timeout reflect actual use rather than a timer.
// A transient failure or incomplete OAuth cookie setup must not force a re-login.
// AuthWrapper's profile restoration handles the final session-state decision.
async function initializeAuth() {
  if (typeof window === "undefined") return;

  // Purge legacy token storage written by older versions of the app.
  localStorage.removeItem("strumm-token");

  // Wait a tick for Zustand to rehydrate from localStorage
  await new Promise(resolve => setTimeout(resolve, 50));

  // Set up the visibility listener once
  setupVisibilityRefresh();

  const result = await refreshSession();
  if (result.ok) return;

  // Transient failure or a session that needs restoring from the NextAuth cookie:
  // keep the rehydrated user visible and retry in the background
  // with backoff. When the API comes back (or the session sync lands), the
  // session slides back in.
  retryRefreshInBackground();
}

// Initialize auth when module loads
if (typeof window !== "undefined") {
  initializeAuth();
}
