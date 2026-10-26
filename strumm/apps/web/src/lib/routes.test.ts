import { describe, expect, it } from "vitest";
import {
  isNavActive,
  isPublicRoute,
  loginUrlFor,
  normalizePathname,
  safeRedirectPath,
} from "./routes";

describe("isPublicRoute", () => {
  it.each([
    "/about",
    "/privacy",
    "/terms",
    "/cookies",
    "/dmca",
    "/contact",
    "/status",
    "/changelog",
    "/faq",
    "/credits",
    "/licenses",
    "/security",
    "/roadmap",
    "/content-removal",
    "/maintenance",
    "/offline",
  ])("lets a signed-out visitor load the footer/legal page %s", (path) => {
    // These are all linked from the public footer. Requiring a session to read
    // the privacy policy is a broken promise and a compliance problem.
    expect(isPublicRoute(path)).toBe(true);
  });

  it.each([
    "/share/abc123",
    "/song/dQw4w9WgXcQ",
    "/podcast/xyz",
    "/public/agnibha",
  ])("keeps the share target %s open to guests", (path) => {
    expect(isPublicRoute(path)).toBe(true);
  });

  it.each([
    "/",
    "/search",
    "/playlists",
    "/playlist/abc",
    "/podcasts",
    "/podcasts/show/abc",
    "/profile",
    "/settings",
    "/rooms/abc",
    "/circle",
    "/stats",
  ])("still requires auth for %s", (path) => {
    expect(isPublicRoute(path)).toBe(false);
  });

  it("does not treat a prefix match on a similarly named private route as public", () => {
    // `/privacysettings` must not match `/privacy`.
    expect(isPublicRoute("/privacysettings")).toBe(false);
    expect(isPublicRoute("/contact-us/admin")).toBe(false);
  });

  it("normalises trailing slashes and query strings", () => {
    expect(isPublicRoute("/privacy/")).toBe(true);
    expect(isPublicRoute("/privacy?ref=footer")).toBe(true);
    expect(isPublicRoute("/privacy#top")).toBe(true);
    expect(normalizePathname("/privacy/?a=1")).toBe("/privacy");
    expect(normalizePathname("/")).toBe("/");
  });
});

describe("isNavActive", () => {
  it("only highlights Home on the exact home path", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/search", "/")).toBe(false);
    expect(isNavActive("/rooms/abc", "/")).toBe(false);
  });

  it("keeps the parent section highlighted on nested routes", () => {
    expect(isNavActive("/rooms/abc123", "/rooms")).toBe(true);
    expect(isNavActive("/search", "/search")).toBe(true);
    expect(isNavActive("/circle/thread/1", "/circle")).toBe(true);
  });

  it("maps plural nav items to their singular detail routes", () => {
    // Regression: `/podcast/<id>` left the sidebar with no active item because
    // the nav href is `/podcasts`. Same for `/playlist/<id>` vs `/playlists`.
    expect(isNavActive("/podcast/abc", "/podcasts")).toBe(true);
    expect(isNavActive("/podcasts/show/abc", "/podcasts")).toBe(true);
    expect(isNavActive("/playlist/abc", "/playlists")).toBe(true);
  });

  it("does not highlight a section for a path that merely shares a prefix", () => {
    expect(isNavActive("/playlistsomething", "/playlists")).toBe(false);
    expect(isNavActive("/roomservice", "/rooms")).toBe(false);
    expect(isNavActive("/podcasting", "/podcasts")).toBe(false);
  });

  it("normalises trailing slashes", () => {
    expect(isNavActive("/rooms/", "/rooms")).toBe(true);
    expect(isNavActive("/playlists/", "/playlists")).toBe(true);
  });
});

describe("safeRedirectPath", () => {
  it("keeps internal paths", () => {
    expect(safeRedirectPath("/rooms/abc")).toBe("/rooms/abc");
    expect(safeRedirectPath("/search?q=lofi")).toBe("/search?q=lofi");
    expect(safeRedirectPath("/playlist/1#tracks")).toBe("/playlist/1#tracks");
    expect(safeRedirectPath("/")).toBe("/");
  });

  it.each([
    "https://evil.example",
    "http://evil.example/login",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "javascript://%0aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "  https://evil.example  ",
    "/path\nSet-Cookie: x=y",
    "\u0000/evil",
    "",
    "   ",
  ])("rejects the unsafe redirect %j", (raw) => {
    expect(safeRedirectPath(raw)).toBe("/");
  });

  it("rejects a value longer than 2KB", () => {
    expect(safeRedirectPath(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("honours a custom fallback", () => {
    expect(safeRedirectPath("https://evil.example", "/profile")).toBe("/profile");
    expect(safeRedirectPath(null, "/profile")).toBe("/profile");
    expect(safeRedirectPath(undefined, "/profile")).toBe("/profile");
  });

  it("decodes the shape a URLSearchParams caller would already have decoded", () => {
    // `?redirect=%2F%2Fevil.example` arrives here as `//evil.example`, because
    // URLSearchParams already decoded it once.
    const fromSearchParams = new URLSearchParams("redirect=%2F%2Fevil.example").get(
      "redirect",
    );
    expect(fromSearchParams).toBe("//evil.example");
    expect(safeRedirectPath(fromSearchParams)).toBe("/");
  });
});

describe("loginUrlFor", () => {
  it("preserves an internal destination", () => {
    expect(loginUrlFor("/rooms/abc")).toBe("/login?redirect=%2Frooms%2Fabc");
  });

  it("collapses the home destination to a bare login URL", () => {
    expect(loginUrlFor("/")).toBe("/login");
  });

  it("never forwards an external destination", () => {
    expect(loginUrlFor("https://evil.example")).toBe("/login");
  });
});
