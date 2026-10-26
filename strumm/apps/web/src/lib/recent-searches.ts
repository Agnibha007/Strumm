/**
 * Recent-search history, kept in localStorage.
 *
 * The value is user-writable and outlives deploys, so it has to be treated as
 * untrusted input: a malformed entry used to throw inside the search page's
 * mount effect and take the page down. Every read is validated and every write
 * is failure-tolerant (private mode / quota).
 */

export const RECENT_SEARCHES_KEY = "strumm-recent-searches";
export const MAX_RECENT_SEARCHES = 10;

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Some privacy modes throw on property access, not just on get/set.
    return null;
  }
}

export function readRecentSearches(storage?: Storage | null): string[] {
  const store = resolveStorage(storage);
  if (!store) return [];

  let raw: string | null = null;
  try {
    raw = store.getItem(RECENT_SEARCHES_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((term): term is string => typeof term === "string" && term.trim().length > 0)
    .slice(0, MAX_RECENT_SEARCHES);
}

export function writeRecentSearches(terms: readonly string[], storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(RECENT_SEARCHES_KEY, JSON.stringify(terms.slice(0, MAX_RECENT_SEARCHES)));
  } catch {
    /* quota / private mode — history is a nicety, not a requirement */
  }
}

/**
 * Put `term` at the front of the history, de-duplicating case-insensitively and
 * capping the list.
 */
export function pushRecentSearch(
  terms: readonly string[],
  term: string,
): string[] {
  const value = term.trim();
  if (!value) return terms.slice(0, MAX_RECENT_SEARCHES);
  const lowered = value.toLowerCase();
  const rest = terms.filter((existing) => existing.toLowerCase() !== lowered);
  return [value, ...rest].slice(0, MAX_RECENT_SEARCHES);
}
