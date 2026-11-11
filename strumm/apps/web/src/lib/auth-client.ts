import {
  useAuthStore,
  refreshSession,
  isAccessTokenExpiredOrAbsent,
} from "web/store/useAuthStore";
import { markSessionExpired } from "web/lib/session-expiry";

let _refreshInFlight: Promise<{ ok: boolean; status: number | null }> | null = null;

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const key = "strumm-device-id";
  let deviceId = window.sessionStorage.getItem(key);
  if (!deviceId || !/^[0-9a-f]{32}$/.test(deviceId)) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    window.sessionStorage.setItem(key, deviceId);
  }
  return deviceId;
}

function singleFlightRefresh() {
  if (!_refreshInFlight) {
    _refreshInFlight = refreshSession().finally(() => {
      _refreshInFlight = null;
    });
  }
  return _refreshInFlight;
}

const bearerOf = (headers: Headers): string | null => {
  const auth = headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return null;
};

/**
 * Drop-in `fetch` replacement for API calls that supports the session lifecycle:
 *
 *  1. Injects the in-memory Bearer token when the caller didn't pass one.
 *  2. On 401/403 it silently refreshes (single-flight, Web-Locks-serialized by the
 *     store) and retries once with the fresh token — so an access token that
 *     expired while the tab was idle in the background is recovered transparently
 *     instead of surfacing as a confusing error.
 *  3. If the refresh is rejected with 401 while we believed we were signed in AND
 *     the access token is genuinely expired, the session is over: the local
 *     session is cleared (AuthWrapper redirects to /login) and a "session
 *     expired" notice is armed for the login page. The user is never left in a
 *     UI that looks signed-in but 401s silently on every request.
 *
 * Transient failures (network blips, API cold starts) never log the user out:
 * the session is only dropped when the server definitively rejects the refresh.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const state = useAuthStore.getState();
  let token = state.token;
  if (
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
    token?.startsWith("dev:")
  ) {
    headers.set("X-Strumm-Dev-User", token.slice(4));
  }
  const explicitBearer = bearerOf(headers);
  if (explicitBearer) token = explicitBearer;
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const attempt = (): Promise<Response> =>
    fetch(url, { ...init, headers, credentials: "include" });

  let response = await attempt();

  if (response.status !== 401) return response;

  // Nothing to recover if we don't believe there is a session at all (e.g. a
  // public endpoint like a share link or the reset-password flow).
  const hadSession = !!token || !!useAuthStore.getState().user;
  if (!hadSession) return response;

  const result = await singleFlightRefresh();
  const refreshed = result.ok && !!useAuthStore.getState().token;
  if (refreshed) {
    headers.set("Authorization", `Bearer ${useAuthStore.getState().token}`);
    response = await attempt();
    if (response.status !== 401) return response;
  }

  // Confirmed-dead session: the server rejected the refresh (401) and the access
  // token is no longer usable. Drop the local session so the app redirects to
  // login instead of silently failing requests, and arm the "session expired"
  // notice for the login page.
  if (
    !refreshed &&
    result.status === 401 &&
    isAccessTokenExpiredOrAbsent(useAuthStore.getState().token)
  ) {
    markSessionExpired();
    useAuthStore.getState().clearLocalSession();
  }

  return response;
}