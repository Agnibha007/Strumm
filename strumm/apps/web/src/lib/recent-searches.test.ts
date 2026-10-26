import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  pushRecentSearch,
  readRecentSearches,
  writeRecentSearches,
} from "./recent-searches";

function memoryStorage(initial?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(RECENT_SEARCHES_KEY, initial);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("readRecentSearches", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(readRecentSearches(memoryStorage())).toEqual([]);
  });

  it("reads a well-formed list", () => {
    expect(readRecentSearches(memoryStorage(JSON.stringify(["lofi", "jazz"])))).toEqual([
      "lofi",
      "jazz",
    ]);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON object", JSON.stringify({ q: "lofi" })],
    ["a JSON string", JSON.stringify("lofi")],
    ["null", "null"],
    ["a number", "42"],
  ])("degrades to an empty list for %s instead of throwing", (_label, raw) => {
    // Regression: JSON.parse in the mount effect used to throw and blank the page.
    expect(() => readRecentSearches(memoryStorage(raw))).not.toThrow();
    expect(readRecentSearches(memoryStorage(raw))).toEqual([]);
  });

  it("drops non-string and blank entries", () => {
    const raw = JSON.stringify(["lofi", 42, null, "", "   ", { q: "x" }, "jazz"]);
    expect(readRecentSearches(memoryStorage(raw))).toEqual(["lofi", "jazz"]);
  });

  it("caps an oversized stored list", () => {
    const raw = JSON.stringify(Array.from({ length: 40 }, (_, i) => `q${i}`));
    expect(readRecentSearches(memoryStorage(raw))).toHaveLength(MAX_RECENT_SEARCHES);
  });

  it("survives a storage that throws on read", () => {
    const store = memoryStorage();
    vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readRecentSearches(store)).toEqual([]);
  });

  it("returns an empty list when storage is unavailable", () => {
    expect(readRecentSearches(null)).toEqual([]);
  });
});

describe("writeRecentSearches", () => {
  it("persists the list", () => {
    const store = memoryStorage();
    writeRecentSearches(["lofi"], store);
    expect(store.getItem(RECENT_SEARCHES_KEY)).toBe(JSON.stringify(["lofi"]));
  });

  it("does not throw when storage rejects the write", () => {
    const store = memoryStorage();
    vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeRecentSearches(["lofi"], store)).not.toThrow();
  });
});

describe("pushRecentSearch", () => {
  it("puts the newest term first", () => {
    expect(pushRecentSearch(["jazz"], "lofi")).toEqual(["lofi", "jazz"]);
  });

  it("moves an existing term to the front without duplicating it", () => {
    expect(pushRecentSearch(["jazz", "lofi"], "lofi")).toEqual(["lofi", "jazz"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(pushRecentSearch(["Lofi"], "lofi")).toEqual(["lofi"]);
  });

  it("ignores a blank term", () => {
    expect(pushRecentSearch(["jazz"], "   ")).toEqual(["jazz"]);
  });

  it("caps the history length", () => {
    const history = Array.from({ length: MAX_RECENT_SEARCHES }, (_, i) => `q${i}`);
    expect(pushRecentSearch(history, "new")).toHaveLength(MAX_RECENT_SEARCHES);
    expect(pushRecentSearch(history, "new")[0]).toBe("new");
  });
});
