import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@strumm/types";
import { apiUrl } from "web/lib/api";

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
          const response = await fetch(apiUrl("/profile"), {
            headers: {
              "Authorization": `Bearer ${token}`
            }
          });
          const json = await response.json();
          if (json.success && json.data) {
            set({ user: json.data });
            return true;
          } else {
            get().logout();
            return false;
          }
        } catch (e) {
          console.warn("Unable to sync profile offline. Using cached user session.");
          return true; // use cached user details
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
