/**
 * Route policy for the shell. Everything a signed-out visitor is allowed to
 * load lives here, so the answer to "can a guest see this?" is one list and not
 * a scattering of `pathname === ...` checks.
 */

/**
 * Public routes that are ALSO in the footer. A guest clicking "Privacy" from the
 * landing page used to be bounced to the login screen, which is both a broken
 * promise (the link is in the footer) and a compliance problem (a privacy policy
 * has to be readable before you sign up).
 */
const PUBLIC_EXACT_ROUTES = new Set([
  "/about",
  "/privacy",
  "/terms",
  "/cookies",
  "/dmca",
  "/contact",
  "/status",
  "/changelog",
  // Other informational pages that are linked from the pages above and carry no
  // user data. Keeping them public means a guest never hits a login wall while
  // reading about the product or its policies.
  "/faq",
  "/credits",
  "/licenses",
  "/security",
  "/roadmap",
  "/content-removal",
  // Standalone operational pages, reachable from error boundaries and redirects.
  "/maintenance",
  "/offline",
  "/downloads",
]);

/**
 * Dynamic public routes. These are the share targets: their whole purpose is to
 * be openable by someone who does not have an account yet.
 */
const PUBLIC_ROUTE_PREFIXES = [
  "/public/",
  "/share/",
  "/song/",
  "/podcast/",
] as const;

/**
 * Normalise a pathname for comparison: drop query/hash if a caller passed a full
 * URL and drop the trailing slash so `/privacy/` and `/privacy` agree.
 */
export function normalizePathname(pathname: string): string {
  const path = (pathname || "/").split(/[?#]/, 1)[0] || "/";
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "") || "/";
  return path;
}

export function isPublicRoute(pathname: string): boolean {
  const path = normalizePathname(pathname);
  if (PUBLIC_EXACT_ROUTES.has(path)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Related routes for a nav item. Detail pages live on a different path segment
 * than their index (`/podcast/<id>` vs `/podcasts`, `/playlist/<id>` vs
 * `/playlists`), so a plain prefix test leaves the sidebar with nothing
 * highlighted while the user is reading an episode or a playlist.
 */
const NAV_SECTION_PREFIXES: Record<string, readonly string[]> = {
  "/playlists": ["/playlists", "/playlist/"],
  "/podcasts": ["/podcasts", "/podcast/"],
};

/**
 * True when `pathname` is inside the section that `href` points at.
 *
 * Exact for the home page (otherwise every route would highlight Home), prefix
 * for everything else so nested routes like `/rooms/abc123` keep their parent
 * highlighted.
 */
export function isNavActive(pathname: string, href: string): boolean {
  const path = normalizePathname(pathname);
  if (href === "/") return path === "/";

  const prefixes = NAV_SECTION_PREFIXES[href] ?? [href];
  return prefixes.some((prefix) => {
    if (prefix.endsWith("/")) return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/**
 * Turn an attacker-controlled `?redirect=` value into a path we are willing to
 * navigate to, or the fallback.
 *
 * The redirect parameter is user input that ends up in `router.replace(...)`.
 * Without this check `?redirect=https://evil.example` (or the protocol-relative
 * `//evil.example`, or a backslash variant that browsers normalise to `//`)
 * turns the login screen into an open redirect with a real, trusted origin.
 *
 * Only same-origin absolute paths survive. Anything else — absolute URLs, `//`,
 * backslashes, control characters, absurdly long values — falls back. This is
 * deliberately a allowlist of shape rather than a blocklist of known-bad URLs.
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  if (typeof raw !== "string") return fallback;

  const value = raw.trim();
  if (!value || value.length > 2048) return fallback;

  // Must be an absolute path on this origin.
  if (!value.startsWith("/")) return fallback;
  // `//host` and `/\host` are protocol-relative once the browser normalises the
  // backslash, i.e. they leave the origin.
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.includes("\\")) return fallback;
  // Control characters can be used to smuggle CR/LF or truncate a URL parser.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  return value;
}

/**
 * Build the login URL for a protected page, preserving where the user was
 * headed. Returns a same-origin path, never an absolute URL.
 */
export function loginUrlFor(redirectTo: string): string {
  const target = safeRedirectPath(redirectTo, "/");
  if (target === "/") return "/login";
  return `/login?redirect=${encodeURIComponent(target)}`;
}
