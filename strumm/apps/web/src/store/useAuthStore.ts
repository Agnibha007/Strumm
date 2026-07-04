import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiFetch, ApiError } from "web/lib/api-client";
import { apiUrl } from "web/lib/api";

interface AuthState {
  user: User | null;
  token: string | null;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  login: (token: string, user: User) => void;
  logout: () => void;
  fetchProfile: () => Promise<boolean>;
  silentRefresh: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      
      setUser: (user) => set({ user }),
      setToken: (token) => set({ token }),
      
      login: (token, user) => {
        set({ token, user });
        if (typeof window !== "undefined") {
          localStorage.setItem("strumm-token", token);
        }
      },
      
      logout: () => {
        set({ token: null, user: null });
        if (typeof window !== "undefined") {
          localStorage.removeItem("strumm-token");
        }
        // Clear refresh timer
        if (typeof window !== "undefined" && (window as any).__strummRefreshTimer) {
          clearTimeout((window as any).__strummRefreshTimer);
          (window as any).__strummRefreshTimer = null;
        }
      },

      silentRefresh: async () => {
        try {
          const res = await fetch(apiUrl("/auth/refresh"), {
            method: "POST",
            credentials: "include",
          });
          const json = await res.json();
          if (json.success && json.data?.token) {
            set({ token: json.data.token, user: json.data.user });
            if (typeof window !== "undefined") {
              localStorage.setItem("strumm-token", json.data.token);
            }
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
      }),
    }
  )
);

// Access token lifetime in ms (15 minutes)
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry
// Periodic activity refresh: every 60 minutes to slide the session window
const ACTIVITY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function scheduleRefresh() {
  if (typeof window === "undefined") return;
  
  // Clear existing timer
  if ((window as any).__strummRefreshTimer) {
    clearTimeout((window as any).__strummRefreshTimer);
  }
  
  // Schedule refresh for (lifetime - buffer) from now
  const delay = ACCESS_TOKEN_LIFETIME_MS - REFRESH_BUFFER_MS;
  (window as any).__strummRefreshTimer = setTimeout(async () => {
    const { token, silentRefresh } = useAuthStore.getState();
    if (token) {
      await silentRefresh();
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
    }
  }, ACTIVITY_REFRESH_INTERVAL_MS);
}

// Attempt immediate silent refresh on page load to slide the session window,
// then schedule the refresh cycle.
async function initializeAuth() {
  if (typeof window === "undefined") return;
  
  // Wait a tick for Zustand to rehydrate from localStorage
  await new Promise(resolve => setTimeout(resolve, 50));
  
  const { token, silentRefresh } = useAuthStore.getState();
  if (!token) return;
  
  // Try a silent refresh immediately on page load to slide the session
  // (silentRefresh internally calls scheduleRefresh() for access token renewal)
  const refreshed = await silentRefresh();
  if (refreshed) {
    // If refresh succeeded, schedule the periodic activity refresh for sliding window
    scheduleActivityRefresh();
  } else {
    // If immediate refresh failed, still schedule the access token refresh cycle
    // so it retries later (e.g., if cookie wasn't immediately available)
    scheduleRefresh();
  }
}

// Initialize auth when module loads
if (typeof window !== "undefined") {
  initializeAuth();
}
