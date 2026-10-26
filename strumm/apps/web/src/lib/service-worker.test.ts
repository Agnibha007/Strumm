import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const serviceWorkerSource = readFileSync(
  resolve(process.cwd(), "public/sw.js"),
  "utf8",
);
const origin = "https://strumm.test";

function createWorker() {
  const listeners = new Map<string, (event: any) => void>();
  const cacheEntries = new Map<string, Response>();
  const cache = {
    add: vi.fn(async (asset: string) => {
      cacheEntries.set(new URL(asset, origin).href, new Response("cached:" + asset));
    }),
    put: vi.fn(async (request: { url: string }, response: Response) => {
      cacheEntries.set(request.url, response);
    }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["strumm-shell-v9"]),
    delete: vi.fn(async () => true),
    match: vi.fn(async (resource: string | { url: string }, options?: { ignoreSearch?: boolean }) => {
      const rawUrl = typeof resource === "string" ? new URL(resource, origin) : new URL(resource.url);
      if (options?.ignoreSearch) rawUrl.search = "";
      return cacheEntries.get(rawUrl.href) || null;
    }),
  };
  const self = {
    addEventListener: (type: string, listener: (event: any) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin },
  };
  const networkFetch = vi.fn(async () => {
    throw new TypeError("Network disconnected");
  });

  runInNewContext(serviceWorkerSource, {
    self,
    caches,
    fetch: networkFetch,
    URL,
    Promise,
    Response,
    Headers,
  });

  return { listeners, cacheEntries, caches, networkFetch };
}

async function installWorker(worker: ReturnType<typeof createWorker>) {
  let installPromise: Promise<unknown> | undefined;
  worker.listeners.get("install")?.({
    waitUntil: (promise: Promise<unknown>) => {
      installPromise = promise;
    },
  });
  await installPromise;
}

function navigationEvent(path: string) {
  let responsePromise: Promise<Response> | undefined;
  const event = {
    request: {
      method: "GET",
      url: new URL(path, origin).href,
      mode: "navigate",
      headers: new Headers({ accept: "text/html" }),
    },
    respondWith: (promise: Promise<Response>) => {
      responsePromise = promise;
    },
  };
  return { event, response: () => responsePromise };
}

describe("PWA service worker offline navigation", () => {
  it("opens Downloads when the podcast route is visited offline", async () => {
    const worker = createWorker();
    await installWorker(worker);
    const { event, response } = navigationEvent("/podcasts");
    worker.listeners.get("fetch")?.(event);

    expect(response()).toBeDefined();
    expect(await (await response()!).text()).toBe("cached:/downloads");
  });

  it("serves the cached Downloads page when the URL has query parameters", async () => {
    const worker = createWorker();
    await installWorker(worker);
    const { event, response } = navigationEvent("/downloads?from=menu");
    worker.listeners.get("fetch")?.(event);

    expect(await (await response()!).text()).toBe("cached:/downloads");
  });

  it("does not intercept live API requests", () => {
    const worker = createWorker();
    const event = {
      request: {
        method: "GET",
        url: new URL("/proxy/podcasts/search", origin).href,
        mode: "cors",
        headers: new Headers(),
      },
      respondWith: vi.fn(),
    };
    worker.listeners.get("fetch")?.(event);

    expect(event.respondWith).not.toHaveBeenCalled();
  });
});
