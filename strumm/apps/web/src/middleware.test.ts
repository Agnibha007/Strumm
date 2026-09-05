import { describe, expect, it } from "vitest";
import { buildCspHeader } from "./middleware";

function connectSrc(csp: string): string | undefined {
  return csp.split("; ").find((d) => d.startsWith("connect-src"));
}

describe("CSP connect-src", () => {
  it("is an explicit allowlist with no blanket https: catch-all (CSP-01)", () => {
    const directive = connectSrc(buildCspHeader("nonce123"));
    expect(directive).toBeDefined();
    expect(directive).not.toMatch(/ https:(?!\/)/);
    // Every group we actually connect to must be present.
    expect(directive).toContain("https://www.googleapis.com");
    expect(directive).toContain("https://www.youtube.com");
    expect(directive).toContain("https://i.ytimg.com");
    expect(directive).toContain("https://*.sentry.io");
    expect(directive).toContain("http://localhost:8000");
    expect(directive).toContain("ws://localhost:8000");
  });

  it("uses a per-request nonce and keeps script-src strict", () => {
    const csp = buildCspHeader("deadbeef");
    const script = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(script).toContain("'nonce-deadbeef'");
    expect(script).not.toContain("'unsafe-inline'");
  });
});