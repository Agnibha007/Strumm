import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiFetch, ApiError } from "web/lib/api-client";
import { apiUrl } from "web/lib/api";

// ---------------------------------------------------------------------------
// Typed global window extensions for auth timers and visibility handler
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __strummRefreshTimer?: ReturnType<typeof setTimeout> | null;
    __strummActivityTimer?: ReturnType<typeof setTimeout> | null;
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

// The API rotates the refresh token on every use. If two refreshes run
// concurrently with the same token (page-load restore + fetchProfile + activity
// timer + visibility handler + proactive apiFetch refresh can all overlap), the
// rotation races: the database ends up holding one token while the browser
// cookie holds another. The next refresh then 401s and the old failure path
// called logout(), which deleted the cookies and revoked the session — forcing
// a re-login after any transient hiccup. Fixes:
//  1. Single-flight: concurrent callers share one in-flight refresh promise.
//  2. Web Locks API: serialize refreshes across browser tabs too.
//  3. Failed refreshes are non-destructive (see clearLocalSession + retry).
let _refreshPromise: Promise<boolean> | null = null;
let _lastRefreshStatus: number | null = null;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      
      setUser: (user) => set({ user }),
      setToken: (token) => set({ token }),
      
      login: (token, user, refreshToken) => {
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
      // still restore the session via silentRefresh once the API is reachable.
      clearLocalSession: () => {
        set({ token: null, user: null, refreshToken: null });
        teardownSessionListeners();
      },

      silentRefresh: () => {
        // Single-flight: concurrent callers (page-load restore, fetchProfile,
        // apiFetch proactive refresh, activity timer, visibility handler) all
        // share one refresh request so the token rotation can't race itself.
        if (_refreshPromise) return _refreshPromise;
        _refreshPromise = acquireRefreshLock(performRefresh)
          .then((result) => result.ok)
          .finally(() => {
            _refreshPromise = null;
          });
        return _refreshPromise;
      },

      fetchProfile: async () => {
        let { token } = get();

        // On reload the token lives only in memory (it is never persisted), so
        // restore the session from the httpOnly cookies before fetching.
        if (!token) {
          const restored = await get().silentRefresh();
          if (!restored) {
            // Non-destructive: a dead/transient refresh must not revoke the
            // server session or wipe the cookies. 401 means the token is truly
            // gone, so drop local state; network/5xx errors keep it (the
            // background retry in initializeAuth handles recovery).
            if (_lastRefreshStatus === 401) {
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
          // If 401/403, try silent refresh first
          if (e instanceof ApiError && e.status && [401, 403].includes(e.status)) {
            const refreshed = await get().silentRefresh();
            if (refreshed) {
              // Retry fetchProfile with new token
              try {
                const data = await apiFetch<any>("/profile", { token: get().token });
                set({ user: data });
                return true;
              } catch {
                get().clearLocalSession();
                return false;
              }
            }
            if (_lastRefreshStatus === 401) {
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

// Access token lifetime in ms (1 hour — matches ACCESS_TOKEN_EXPIRE on the API)
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh 10 minutes before expiry for reliability
// Periodic activity refresh: every 10 minutes to slide the session window during active use
const ACTIVITY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
// Retry interval for failed refreshes (with exponential backoff)
const REFRESH_RETRY_INTERVAL_MS = 30 * 1000; // 30 seconds
const REFRESH_RETRY_MAX_INTERVAL_MS = 5 * 60 * 1000; // cap at 5 minutes

/**
 * Schedule the next access token refresh, with retry on failure.
 * Uses exponential backoff up to a cap.
 */
/** Guard to prevent concurrent refreshes (e.g., timer + visibility firing at the same time). */
let _refreshing = false;

// Clears refresh/activity timers and the visibility listener. Does not touch the
// server session or the cookies.
function teardownSessionListeners() {
  if (typeof window === "undefined") return;
  if (window.__strummRefreshTimer) {
    clearTimeout(window.__strummRefreshTimer);
    window.__strummRefreshTimer = null;
  }
  if (window.__strummActivityTimer) {
    clearTimeout(window.__strummActivityTimer);
    window.__strummActivityTimer = null;
  }
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

// Single refresh attempt. Rotates the refresh token server-side and, on success,
// updates local state and schedules the next refresh. Records the HTTP status for
// callers to distinguish "session truly dead" (401) from transient failures.
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
    _lastRefreshStatus = res.status;
    const json = await res.json();
    if (json.success && json.data?.token) {
      useAuthStore.setState({
        token: json.data.token,
        user: json.data.user,
        refreshToken: json.data.refreshToken || refreshToken,
      });
      scheduleRefresh();
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status };
  } catch {
    _lastRefreshStatus = null;
    return { ok: false, status: null };
  }
}

// Bounded retry for transient failures (deploy restarts, HF Spaces cold start).
// Does not run on a 401 (the session is genuinely gone) and never destroys the
// server session or the cookies.
async function retryRefreshInBackground() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
    await new Promise((resolve) => setTimeout(resolve, backoff));

    if (useAuthStore.getState().token) return; // recovered elsewhere
    const ok = await useAuthStore.getState().silentRefresh();
    if (ok) {
      scheduleActivityRefresh();
      return;
    }
    if (_lastRefreshStatus === 401) {
      useAuthStore.getState().clearLocalSession();
      return;
    }
  }
}

function scheduleRefresh(attempt = 0) {
  if (typeof window === "undefined") return;

  // Clear existing timer
  if (window.__strummRefreshTimer) {
    clearTimeout(window.__strummRefreshTimer);
  }

  // Compute delay: normal schedule on first attempt, backoff on retries
  const normalDelay = ACCESS_TOKEN_LIFETIME_MS - REFRESH_BUFFER_MS;
  const retryDelay = Math.min(
    REFRESH_RETRY_INTERVAL_MS * Math.pow(2, attempt - 1),
    REFRESH_RETRY_MAX_INTERVAL_MS
  );
  const delay = attempt === 0 ? normalDelay : retryDelay;

  window.__strummRefreshTimer = setTimeout(async () => {
    if (_refreshing) return; // skip if already refreshing

    const { token, silentRefresh } = useAuthStore.getState();
    if (token) {
      _refreshing = true;
      const ok = await silentRefresh();
      _refreshing = false;
      if (!ok) {
        // Refresh failed — schedule a retry with backoff
        scheduleRefresh(attempt + 1);
      }
      // On success, silentRefresh() already called scheduleRefresh(0) internally
    }
  }, delay);
}

// Periodic activity-based refresh to slide the session window
function scheduleActivityRefresh() {
  if (typeof window === "undefined") return;

  // Clear existing timer
  if (window.__strummActivityTimer) {
    clearTimeout(window.__strummActivityTimer);
  }

  // Refresh every hour to keep the session sliding
  window.__strummActivityTimer = setTimeout(async () => {
    const { token, silentRefresh } = useAuthStore.getState();
    if (token) {
      const refreshed = await silentRefresh();
      if (refreshed) {
        // Reschedule for another hour
        scheduleActivityRefresh();
      }
      // If refresh fails here, scheduleRefresh's retry mechanism handles it
    }
  }, ACTIVITY_REFRESH_INTERVAL_MS);
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

// Attempt immediate silent refresh on page load to slide the session window,
// then schedule the refresh cycle. Crucially, a failed refresh here never
// revokes the server session or deletes the cookies: a transient failure
// (deploy restart, network blip, token-rotation race) must not force a
// re-login. The cookies stay in place so the next load can restore the session.
async function initializeAuth() {
  if (typeof window === "undefined") return;

  // Purge legacy token storage written by older versions of the app.
  localStorage.removeItem("strumm-token");

  // Wait a tick for Zustand to rehydrate from localStorage
  await new Promise(resolve => setTimeout(resolve, 50));

  // Set up the visibility listener once
  setupVisibilityRefresh();

  const refreshed = await useAuthStore.getState().silentRefresh();
  if (refreshed) {
    // If refresh succeeded, schedule the periodic activity refresh for sliding window
    scheduleActivityRefresh();
    return;
  }

  // The session is genuinely gone (401) — drop local state but keep the cookies
  // so a later load can still recover.
  if (_lastRefreshStatus === 401) {
    useAuthStore.getState().clearLocalSession();
    return;
  }

  // Transient failure: keep the rehydrated user visible and retry in the
  // background with backoff. When the API comes back, the session slides back in.
  retryRefreshInBackground();
}

// Initialize auth when module loads
if (typeof window !== "undefined") {
  initializeAuth();
}
