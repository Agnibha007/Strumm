// Minimal in-memory localStorage for the jsdom test environment.
// Node 22+ exposes an experimental global localStorage that our vitest setup
// does not enable, and zustand's `persist` middleware (used by several stores)
// needs a working localStorage.
class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis !== "undefined") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
  if (typeof globalThis.window === "object" && globalThis.window && !("localStorage" in globalThis.window)) {
    Object.defineProperty(globalThis.window, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  }
}