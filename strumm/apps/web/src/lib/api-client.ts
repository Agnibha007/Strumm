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

  // Proactive refresh: if token is about to expire (< 6 min remaining), silently refresh now
  if (effectiveToken) {
    const payload = decodeJwtPayload(effectiveToken);
    if (payload?.exp) {
      const expiresAt = Number(payload.exp) * 1000;
      const remaining = expiresAt - Date.now();
      if (remaining < 6 * 60 * 1000) {
        const store = await import("web/store/useAuthStore");
        const refreshed = await store.useAuthStore.getState().silentRefresh();
        if (refreshed) {
          effectiveToken = store.useAuthStore.getState().token;
        }
      }
    }
  }

  if (effectiveToken) {
    headers.set("Authorization", `Bearer ${effectiveToken}`);
  }
  if (rest.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...rest,
    headers,
    credentials: "include",
  });
  const json = (await response.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error || "Request failed", response.status);
  }

  return json.data as T;
}
