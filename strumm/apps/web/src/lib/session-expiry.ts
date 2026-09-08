export const SESSION_EXPIRED_KEY = "strumm-session-expired";

export function markSessionExpired() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_EXPIRED_KEY, "true");
  } catch {
    // Private-mode storage failures must not break the request path.
  }
}

export function consumeSessionExpiredNotice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const expired = sessionStorage.getItem(SESSION_EXPIRED_KEY) === "true";
    if (expired) sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    return expired;
  } catch {
    return false;
  }
}