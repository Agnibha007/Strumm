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

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { token, headers: customHeaders, ...rest } = options;

  const headers = new Headers(customHeaders);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (rest.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(apiUrl(path), { ...rest, headers });
  const json = (await response.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error || "Request failed", response.status);
  }

  return json.data as T;
}
