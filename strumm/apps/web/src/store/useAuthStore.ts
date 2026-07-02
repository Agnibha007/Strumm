import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiFetch, ApiError } from "web/lib/api-client";

interface AuthState {
  user: User | null;
  token: string | null;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  login: (token: string, user: User) => void;
  logout: () => void;
  fetchProfile: () => Promise<boolean>;
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
      },

      fetchProfile: async () => {
        const { token } = get();
        if (!token) return false;
        
        try {
          const data = await apiFetch<any>("/profile", { token });
          set({ user: data });
          return true;
        } catch (e) {
          // If 401/403, clear expired session
          if (e instanceof ApiError && e.status && [401, 403].includes(e.status)) {
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
