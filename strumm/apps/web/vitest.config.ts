import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      web: path.resolve(__dirname, "src"),
      "@strumm/types": path.resolve(__dirname, "../../packages/types/src"),
      "@strumm/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
});
