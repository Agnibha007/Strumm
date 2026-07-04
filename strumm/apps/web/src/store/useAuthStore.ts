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

// Start refresh cycle when module loads (if logged in)
if (typeof window !== "undefined") {
  const { token } = useAuthStore.getState();
  if (token) {
    scheduleRefresh();
  }
}
