import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ThemeType } from "@strumm/types";

interface ThemeState {
  currentTheme: ThemeType;
  customImage: string | null;
  isAnimated: boolean;
  extractedColor: string | null;
  setTheme: (theme: ThemeType) => void;
  setCustomImage: (url: string | null) => void;
  setAnimated: (animated: boolean) => void;
  setExtractedColor: (color: string | null) => void;
  resetTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      currentTheme: "Obsidian",
      customImage: null,
      isAnimated: true,
      extractedColor: null,
      setTheme: (theme) => {
        set({ currentTheme: theme });
        if (typeof document !== "undefined") {
          document.documentElement.setAttribute("data-theme", theme);
        }
      },
      setCustomImage: (url) => set({ customImage: url }),
      setAnimated: (animated) => {
        set({ isAnimated: animated });
        if (typeof document !== "undefined") {
          document.documentElement.setAttribute("data-reduced-motion", animated ? "false" : "true");
        }
      },
      setExtractedColor: (color) => {
        set({ extractedColor: color });
        if (typeof document !== "undefined" && color) {
          document.documentElement.style.setProperty("--extracted-color", color);
        }
      },
      resetTheme: () => {
        set({
          currentTheme: "Obsidian",
          customImage: null,
          isAnimated: true,
          extractedColor: null,
        });
        if (typeof document !== "undefined") {
          document.documentElement.setAttribute("data-theme", "Obsidian");
          document.documentElement.setAttribute("data-reduced-motion", "false");
          document.documentElement.style.removeProperty("--extracted-color");
        }
      },
    }),
    {
      name: "strumm-theme-cache",
      onRehydrateStorage: () => (state) => {
        // Apply theme from localStorage immediately upon page load to prevent flash of wrong theme
        if (state && typeof document !== "undefined") {
          document.documentElement.setAttribute("data-theme", state.currentTheme);
          document.documentElement.setAttribute("data-reduced-motion", state.isAnimated ? "false" : "true");
          if (state.extractedColor) {
            document.documentElement.style.setProperty("--extracted-color", state.extractedColor);
          }
        }
      },
    }
  )
);
