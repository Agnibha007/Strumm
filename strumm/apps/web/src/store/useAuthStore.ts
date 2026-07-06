import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiFetch, ApiError } from "web/lib/api-client";
import { apiUrl } from "web/lib/api";

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
}

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
        // Token is stored in httpOnly cookies for API auth
        // Zustand persist middleware handles localStorage cache
      },
      
      logout: () => {
        const { refreshToken } = get();

        // Revoke session on the server before clearing local state
        if (typeof window !== "undefined" && refreshToken) {
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
        // Clear refresh timer
        if (typeof window !== "undefined" && (window as any).__strummRefreshTimer) {
          clearTimeout((window as any).__strummRefreshTimer);
          (window as any).__strummRefreshTimer = null;
        }
        // Clear activity timer
        if (typeof window !== "undefined" && (window as any).__strummActivityTimer) {
          clearTimeout((window as any).__strummActivityTimer);
          (window as any).__strummActivityTimer = null;
        }
        // Remove visibility listener
        if (typeof window !== "undefined" && (window as any).__strummVisibilityHandler) {
          document.removeEventListener("visibilitychange", (window as any).__strummVisibilityHandler);
          (window as any).__strummVisibilityHandler = null;
        }
      },

      silentRefresh: async () => {
        try {
          const { refreshToken } = get();
          if (!refreshToken) return false;

          const res = await fetch(apiUrl("/auth/refresh"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ refreshToken }),
          });
          const json = await res.json();
          if (json.success && json.data?.token) {
            set({
              token: json.data.token,
              user: json.data.user,
              refreshToken: json.data.refreshToken || refreshToken,
            });
            // Token is stored in httpOnly cookies
            // Schedule next refresh
            scheduleRefresh();
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },

      fetchProfile: async () => {
        const { token } = get();
        if (!token) return false;
        
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
                get().logout();
                return false;
              }
            }
            get().logout();
            return false;
          }
          console.warn("Unable to sync profile offline. Using cached user session.");
          return true;
        }
      }
    }),
    {
      name: "strumm-auth-cache",
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        refreshToken: state.refreshToken,
      }),
    }
  )
);

// Access token lifetime in ms (15 minutes)
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_BUFFER_MS = 3 * 60 * 1000; // refresh 3 minutes before expiry for reliability
// Periodic activity refresh: every 60 minutes to slide the session window
const ACTIVITY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// Retry interval for failed refreshes (with exponential backoff)
const REFRESH_RETRY_INTERVAL_MS = 30 * 1000; // 30 seconds
const REFRESH_RETRY_MAX_INTERVAL_MS = 5 * 60 * 1000; // cap at 5 minutes

/**
 * Schedule the next access token refresh, with retry on failure.
 * Uses exponential backoff up to a cap.
 */
function scheduleRefresh(attempt = 0) {
  if (typeof window === "undefined") return;

  // Clear existing timer
  if ((window as any).__strummRefreshTimer) {
    clearTimeout((window as any).__strummRefreshTimer);
  }

  // Compute delay: normal schedule on first attempt, backoff on retries
  const normalDelay = ACCESS_TOKEN_LIFETIME_MS - REFRESH_BUFFER_MS;
  const retryDelay = Math.min(
    REFRESH_RETRY_INTERVAL_MS * Math.pow(2, attempt - 1),
    REFRESH_RETRY_MAX_INTERVAL_MS
  );
  const delay = attempt === 0 ? normalDelay : retryDelay;

  (window as any).__strummRefreshTimer = setTimeout(async () => {
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
  if ((window as any).__strummActivityTimer) {
    clearTimeout((window as any).__strummActivityTimer);
  }

  // Refresh every hour to keep the session sliding
  (window as any).__strummActivityTimer = setTimeout(async () => {
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
/** Guard to prevent concurrent refreshes (e.g., timer + visibility firing at the same time). */
let _refreshing = false;

function setupVisibilityRefresh() {
  if (typeof window === "undefined") return;

  const handler = async () => {
    if (document.visibilityState !== "visible") return;
    if (_refreshing) return; // skip if already refreshing

    const { token } = useAuthStore.getState();
    if (!token) return;

    // Decode the JWT to check remaining time without a network call
    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return;      const expiresAt = Number(payload.exp) * 1000;
      const remaining = expiresAt - Date.now();

    // If less than 5 minutes remain, refresh proactively
    if (remaining < 5 * 60 * 1000) {
      _refreshing = true;
      const { silentRefresh } = useAuthStore.getState();
      await silentRefresh();
      _refreshing = false;
    }
  };

  document.addEventListener("visibilitychange", handler);
  // Store reference for cleanup on logout
  (window as any).__strummVisibilityHandler = handler;
}

/** Decode a JWT's payload (base64url) without verification — client-side expiry check only. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// Attempt immediate silent refresh on page load to slide the session window,
// then schedule the refresh cycle.
async function initializeAuth() {
  if (typeof window === "undefined") return;

  // Wait a tick for Zustand to rehydrate from localStorage
  await new Promise(resolve => setTimeout(resolve, 50));

  const { token, silentRefresh } = useAuthStore.getState();
  if (!token) return;

  // Set up the visibility listener once
  setupVisibilityRefresh();

  // Try a silent refresh immediately on page load to slide the session
  const refreshed = await silentRefresh();
  if (refreshed) {
    // If refresh succeeded, schedule the periodic activity refresh for sliding window
    scheduleActivityRefresh();
  } else {
    // If immediate refresh failed, schedule the access token refresh cycle with retry
    scheduleRefresh(0);
  }
}

// Initialize auth when module loads
if (typeof window !== "undefined") {
  initializeAuth();
}
