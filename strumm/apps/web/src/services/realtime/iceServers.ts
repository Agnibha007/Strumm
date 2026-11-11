import { authFetch } from "web/lib/auth-client";
import { apiUrl } from "web/lib/api";

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

const cachedServers = new Map<string, { expiresAt: number; servers: RTCIceServer[] }>();
const pendingRequests = new Map<string, Promise<RTCIceServer[]>>();

function isIceServer(value: unknown): value is RTCIceServer {
  if (!value || typeof value !== "object") return false;
  const server = value as Record<string, unknown>;
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((url) =>
    typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url),
  )) return false;
  const hasTurn = urls.some((url) => /^(turn|turns):/i.test(String(url)));
  return !hasTurn || (typeof server.username === "string" && typeof server.credential === "string");
}

export async function getRoomIceServers(roomId: string): Promise<RTCIceServer[]> {
  const cached = cachedServers.get(roomId);
  if (cached && cached.expiresAt > Date.now()) return cached.servers;
  const pending = pendingRequests.get(roomId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const response = await authFetch(apiUrl("/social/rooms/" + encodeURIComponent(roomId) + "/ice-servers"));
      if (!response.ok) throw new Error("ICE configuration request failed (" + response.status + ")");
      const payload = await response.json();
      const configured = payload?.data?.iceServers;
      if (!Array.isArray(configured)) throw new Error("ICE configuration response was invalid");
      const servers = configured.filter(isIceServer);
      const result = servers.length ? servers : FALLBACK_ICE_SERVERS;
      cachedServers.set(roomId, { expiresAt: Date.now() + 30 * 60 * 1000, servers: result });
      return result;
    } catch {
      cachedServers.set(roomId, { expiresAt: Date.now() + 60 * 1000, servers: FALLBACK_ICE_SERVERS });
      return FALLBACK_ICE_SERVERS;
    } finally {
      pendingRequests.delete(roomId);
    }
  })();

  pendingRequests.set(roomId, request);
  return request;
}
