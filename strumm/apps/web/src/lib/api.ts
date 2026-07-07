const DEFAULT_API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : "http://localhost:8000");

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

export function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
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
