import { apiUrl } from "web/lib/api";
import type { ApiResponse } from "@strumm/types";

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ApiFetchOptions = RequestInit & {
  token?: string | null;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { token, headers: customHeaders, ...rest } = options;

  const headers = new Headers(customHeaders);
  // Use explicitly passed token, or fall back to the token stored in Zustand
  // (which comes from the login response body as a safety net alongside httpOnly cookies)
  // Lazy import to avoid circular dependency with useAuthStore -> apiFetch
  let effectiveToken = token;
  if (!effectiveToken) {
    const store = await import("web/store/useAuthStore");
    effectiveToken = store.useAuthStore.getState().token;
  }

  // Proactive refresh: if token is about to expire (< 10 min remaining), silently refresh now
  if (effectiveToken) {
    const payload = decodeJwtPayload(effectiveToken);
    if (payload?.exp) {
      const expiresAt = Number(payload.exp) * 1000;
      const remaining = expiresAt - Date.now();
      if (remaining < 10 * 60 * 1000) {
        const store = await import("web/store/useAuthStore");
        const refreshed = await store.useAuthStore.getState().silentRefresh();
        if (refreshed) {
          effectiveToken = store.useAuthStore.getState().token;
        }
      }
    }
  }

  if (
    effectiveToken?.startsWith("dev:") &&
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ) {
    headers.set("X-Strumm-Dev-User", effectiveToken.slice(4));
  }
  if (effectiveToken) {
    headers.set("Authorization", `Bearer ${effectiveToken}`);
  }
  if (rest.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const attemptFetch = (): Promise<Response> =>
    fetch(apiUrl(path), {
      ...rest,
      headers,
      credentials: "include",
    });

  let response = await attemptFetch();

  // Reactive retry: only attempt session recovery if this request belonged to
  // an authenticated user. Public endpoints must not trigger login/session churn.
  if (response.status === 401) {
    const store = await import("web/store/useAuthStore");
    const hadSession = !!effectiveToken || !!store.useAuthStore.getState().user;
    if (hadSession) {
      const refresh = await store.refreshSession();
      if (refresh.ok) {
        headers.set("Authorization", `Bearer ${store.useAuthStore.getState().token}`);
        response = await attemptFetch();
      } else if (
        refresh.status === 401 &&
        store.isAccessTokenExpiredOrAbsent(store.useAuthStore.getState().token)
      ) {
        const { markSessionExpired } = await import("web/lib/session-expiry");
        markSessionExpired();
        store.useAuthStore.getState().clearLocalSession();
      }
    }
  }

  const json = (await response.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error || "Request failed", response.status);
  }

  return json.data as T;
}
