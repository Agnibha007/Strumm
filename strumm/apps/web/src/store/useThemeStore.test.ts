import { describe, it, expect, beforeEach } from "vitest";
import { useThemeStore } from "./useThemeStore";

describe("useThemeStore custom colors (Feature 4)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.setProperty("--custom-primary", "");
    document.documentElement.style.setProperty("--custom-primary-hover", "");
    document.documentElement.style.setProperty("--custom-accent", "");
    document.documentElement.style.setProperty("--custom-text", "");
    useThemeStore.persist?.clearStorage?.();
    useThemeStore.setState({
      currentTheme: "Obsidian",
      customImage: null,
      isAnimated: true,
      extractedColor: null,
      customPrimary: "#6C8CFF",
      customText: "#F5F7FF",
    });
  });

  it("defaults to the built-in blue/text colors", () => {
    const { customPrimary, customText } = useThemeStore.getState();
    expect(customPrimary).toBe("#6C8CFF");
    expect(customText).toBe("#F5F7FF");
  });

  it("stores custom colors without touching the DOM outside Custom theme", () => {
    useThemeStore.getState().setCustomColors({ primary: "#FF5500", text: "#FFFFFF" });
    const s = useThemeStore.getState();
    expect(s.customPrimary).toBe("#FF5500");
    expect(s.customText).toBe("#FFFFFF");
    // Obsidian theme active -> DOM vars are NOT applied.
    expect(document.documentElement.style.getPropertyValue("--custom-primary")).toBe("");
  });

  it("applies CSS custom properties when the Custom theme is active", () => {
    useThemeStore.setState({ currentTheme: "Custom" });
    useThemeStore.getState().setCustomColors({ primary: "#00FF88", text: "#F5F7FF" });

    expect(document.documentElement.style.getPropertyValue("--custom-primary")).toBe("#00FF88");
    expect(document.documentElement.style.getPropertyValue("--custom-text")).toBe("#F5F7FF");
    // Hover variant is derived and also applied.
    expect(document.documentElement.style.getPropertyValue("--custom-primary-hover")).toMatch(/^#/);
  });

  it("persists custom colors across rehydrate", () => {
    useThemeStore.setState({ currentTheme: "Custom" });
    useThemeStore.getState().setCustomColors({ primary: "#123456", text: "#ABCDEF" });
    const stored = localStorage.getItem("strumm-theme-cache");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string);
    expect(parsed.state.customPrimary).toBe("#123456");
    expect(parsed.state.customText).toBe("#ABCDEF");
  });
});