import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web/lib/auth-client", () => ({ authFetch: vi.fn() }));
vi.mock("web/lib/api", () => ({ apiUrl: (path: string) => path }));

import { authFetch } from "web/lib/auth-client";

describe("getRoomIceServers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(authFetch).mockReset();
  });

  it("loads authenticated room ICE configuration from the API", async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          iceServers: [
            { urls: "stun:stun.cloudflare.com:3478" },
            { urls: ["turn:turn.cloudflare.com:3478"], username: "temporary", credential: "secret" },
          ],
        },
      }),
    } as Response);

    const { getRoomIceServers } = await import("./iceServers");
    const servers = await getRoomIceServers("room-123");

    expect(authFetch).toHaveBeenCalledWith("/social/rooms/room-123/ice-servers");
    expect(servers).toHaveLength(2);
    expect(servers[1]).toMatchObject({ username: "temporary", credential: "secret" });
  });

  it("rejects invalid ICE URLs and falls back to public STUN", async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { iceServers: [{ urls: "https://invalid.example" }] } }),
    } as Response);

    const { getRoomIceServers } = await import("./iceServers");
    const servers = await getRoomIceServers("room-123");

    expect(servers).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ]);
  });

  it("falls back to STUN if the API request fails", async () => {
    vi.mocked(authFetch).mockRejectedValue(new Error("offline"));

    const { getRoomIceServers } = await import("./iceServers");
    const servers = await getRoomIceServers("room-123");

    expect(servers).toHaveLength(2);
    expect(servers.every((server) => String(server.urls).startsWith("stun:"))).toBe(true);
  });

  it("shares an in-flight request and caches credentials per room", async () => {
    let resolveResponse!: (value: Response) => void;
    vi.mocked(authFetch).mockReturnValue(new Promise((resolve) => { resolveResponse = resolve; }));

    const { getRoomIceServers } = await import("./iceServers");
    const first = getRoomIceServers("room-123");
    const second = getRoomIceServers("room-123");
    resolveResponse({
      ok: true,
      json: async () => ({ data: { iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "p" }] } }),
    } as Response);

    const [a, b] = await Promise.all([first, second]);
    expect(authFetch).toHaveBeenCalledOnce();
    expect(a).toEqual(b);
    expect(await getRoomIceServers("room-123")).toEqual(a);
    expect(authFetch).toHaveBeenCalledOnce();
    expect(await getRoomIceServers("room-456")).toEqual(a);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });
});
