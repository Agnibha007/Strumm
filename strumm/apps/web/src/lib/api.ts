// Absolute origin of the backend API. Used only for connections that need a
// real origin at runtime (WebSocket). All HTTP traffic goes through the
// same-origin /proxy rewrite in next.config.ts so the browser never does
// cross-origin calls (the HF Spaces gateway does not send
// Access-Control-Allow-Credentials, which broke every cookie-authenticated
// request).
export const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://localhost:8000"
).replace(/\/+$/, "");

// Kept for back-compat; points at the same origin as API_ORIGIN.
export const API_BASE_URL = API_ORIGIN;

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Relative, same-origin: routed by the /proxy rewrite in next.config.ts.
  return `/proxy${normalizedPath}`;
}

export function cleanUsername(value: string) {
  return cleanText(value, 30).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

export function decodeHtml(html: string): string {
  if (!html) return "";
  // Decode iteratively to handle double-encoded entities (e.g. &amp;amp; -> &)
  let prev: string;
  let result = html;
  do {
    prev = result;
    result = result
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'");
  } while (result !== prev);
  return result;
}

export function stripHtml(html: string): string {
  if (!html) return "";
  const decoded = decodeHtml(html);
  return decoded.replace(/<[^>]*>/g, "");
}

export function cleanText(value: string, maxLength = 500) {
  return decodeHtml(value).replace(/\0/g, "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}
