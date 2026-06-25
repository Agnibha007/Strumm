const PUBLIC_ROUTE_PREFIXES = [
  "/public/",
  "/share/",
  "/song/",
  "/podcast/",
] as const;

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
