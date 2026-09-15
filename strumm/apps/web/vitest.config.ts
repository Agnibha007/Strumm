import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      web: path.resolve(__dirname, "src"),
      "@strumm/types": path.resolve(__dirname, "../../packages/types/src"),
      "@strumm/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  // The app's tsconfig sets `jsx: preserve` (Next transforms JSX at build).
  // Vitest doesn't run Next's transform, so apply the automatic React runtime
  // for component tests (matches the runtime Next uses under the hood).
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
