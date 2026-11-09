const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges, X-Ytdown-Final-Url",
  "access-control-max-age": "86400",
};


const HEADER_ALIASES: Record<string, string> = {
  "x-ytdown-origin": "origin",
  "x-ytdown-referer": "referer",
};


function allowedOrigin(request: Request, env: { ALLOWED_ORIGINS?: string }): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function allowedTarget(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === "youtube.com"
      || host.endsWith(".youtube.com")
      || host === "youtube-nocookie.com"
      || host.endsWith(".youtube-nocookie.com")
      || host === "googlevideo.com"
      || host.endsWith(".googlevideo.com");
    if (url.protocol !== "https:" || url.port || url.username || url.password || !allowedHost) return null;
    return url;
  } catch {
    return null;
  }
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers(CORS_HEADERS);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return headers;
}

async function fetchAllowedTarget(target: URL, init: RequestInit): Promise<Response> {
  let current = target;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 4) return new Response("Too many redirects", { status: 502 });
    const redirectTarget = new URL(location, current);
    const next = allowedTarget(redirectTarget.toString());
    if (!next) return new Response(`Redirect target is not allowed: ${redirectTarget.hostname}`, { status: 403 });
    current = next;
  }
  return new Response("Too many redirects", { status: 502 });
}

const worker = {
  async fetch(request: Request, env: { ALLOWED_ORIGINS?: string }): Promise<Response> {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response("Origin not allowed", { status: 403 });
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }
    const targetValue = new URL(request.url).searchParams.get("url");
    if (!targetValue || targetValue.length > 8192) {
      return new Response("Invalid target URL", { status: 400, headers: cors });
    }
    const target = allowedTarget(targetValue);
    if (!target) return new Response("Target host is not allowed", { status: 403, headers: cors });
    const headers = new Headers();
    for (const name of ["content-type", "range", "x-goog-api-key", "x-youtube-client-name", "x-youtube-client-version"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const [alias, real] of Object.entries(HEADER_ALIASES)) {
      const value = request.headers.get(alias);
      if (value) headers.set(real, value);
    }
    if (!headers.has("origin")) headers.set("origin", "https://www.youtube.com");
    if (!headers.has("referer")) headers.set("referer", "https://www.youtube.com/");
    const requestedUserAgent = request.headers.get("x-ytdown-user-agent");
    if (requestedUserAgent && requestedUserAgent.length <= 512 && /^[\x20-\x7E]+$/.test(requestedUserAgent)) {
      headers.set("user-agent", requestedUserAgent);
    } else if (target.hostname.endsWith(".googlevideo.com") && target.searchParams.get("c") === "IOS") {
      headers.set("user-agent", "com.google.ios.youtube/20.14.2 (iPhone16,2; U; CPU iOS 18_4 like Mac OS X)");
    } else if (!headers.has("user-agent")) {
      headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36");
    }
    const upstream = await fetchAllowedTarget(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
    });
    const responseHeaders = new Headers(cors);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (upstream.url) responseHeaders.set("x-ytdown-final-url", upstream.url);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};

export default worker;
