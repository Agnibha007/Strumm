import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ThemeType } from "@strumm/types";

interface ThemeState {
  currentTheme: ThemeType;
  customImage: string | null;
  isAnimated: boolean;
  extractedColor: string | null;
  customPrimary: string;
  customText: string;
  setTheme: (theme: ThemeType) => void;
  setCustomImage: (url: string | null) => void;
  setAnimated: (animated: boolean) => void;
  setExtractedColor: (color: string | null) => void;
  setCustomColors: (opts?: { primary?: string; text?: string }) => void;
  resetTheme: () => void;
}

const applyCustomColors = (primary: string, text: string) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--custom-primary", primary);
  root.style.setProperty("--custom-primary-hover", lighten(primary));
  root.style.setProperty("--custom-accent", primary);
  root.style.setProperty("--custom-text", text);
};

// Lighten a hex color by ~25% for the hover state.
function lighten(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + 64);
  const g = Math.min(255, ((num >> 8) & 0xff) + 64);
  const b = Math.min(255, (num & 0xff) + 64);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      currentTheme: "Obsidian",
      customImage: null,
      isAnimated: true,
      extractedColor: null,
      customPrimary: "#6C8CFF",
      customText: "#F5F7FF",
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
      setCustomColors: (opts) => {
        const state = useThemeStore.getState();
        const primary = opts?.primary ?? state.customPrimary;
        const text = opts?.text ?? state.customText;
        set({ customPrimary: primary, customText: text });
        if (state.currentTheme === "Custom") {
          applyCustomColors(primary, text);
        }
      },
      resetTheme: () => {
        set({
          currentTheme: "Obsidian",
          customImage: null,
          isAnimated: true,
          extractedColor: null,
          customPrimary: "#6C8CFF",
          customText: "#F5F7FF",
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
          if (state.customPrimary && state.customText) {
            applyCustomColors(state.customPrimary, state.customText);
          }
        }
      },
    }
  )
);