import { NextRequest, NextResponse } from "next/server";

const apiOrigin = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/+$/, "");

function buildCspHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    // No 'unsafe-inline' / 'unsafe-eval' here. Inline scripts are allowed only
    // when they carry this request's nonce; Next.js automatically applies the
    // nonce to the bootstrap scripts it injects, and our own inline script in
    // <head> receives it explicitly (see layout.tsx).
    `script-src 'self' 'nonce-${nonce}' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com https://static.cloudflareinsights.com`,
    `frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com`,
    `img-src 'self' data: https:`,
    `media-src 'self' https: data: blob:`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `connect-src 'self' ${apiOrigin} ${apiOrigin
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")} https://www.youtube.com https://s.ytimg.com https://i.ytimg.com https://img.youtube.com https://lh3.googleusercontent.com https://*.sentry.io https:`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only HTML documents need a CSP. Everything else (fonts, images, JS
  // bundles, API routes, Sentry tunnel) is excluded to keep headers light.
  if (pathname.startsWith("/_next/")) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname === "/monitoring") return NextResponse.next();
  if (/\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|json|txt|woff2?|mp3|mp4)$/.test(pathname)) {
    return NextResponse.next();
  }

  const nonce = crypto.randomUUID().replace(/-/g, "");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Dev mode relies on eval (fast-refresh source maps) and dev-only inline
  // scripts, so only enforce the strict nonce-based CSP in production.
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Content-Security-Policy", buildCspHeader(nonce));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
