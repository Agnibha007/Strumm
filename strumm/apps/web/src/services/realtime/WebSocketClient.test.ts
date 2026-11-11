import { afterEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(JSON.parse(value));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean: true } as CloseEvent);
  }
}

describe("WebSocketClient room subscriptions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
    vi.resetModules();
  });

  it("restores room subscriptions after authentication and reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { WebSocketClient } = await import("./WebSocketClient");
    const client = WebSocketClient.getInstance();
    const roomId = "room-123";
    const deviceId = "0123456789abcdef0123456789abcdef";

    client.subscribeRoom(roomId, deviceId);
    client.connect("access-token");
    const first = MockWebSocket.instances[0];
    first.open();
    expect(first.sent[0]).toEqual({ event: "authenticate", data: { token: "access-token" } });
    first.message({ event: "connected", data: {} });
    expect(first.sent.filter((message) => message.event === "room:subscribe")).toHaveLength(1);

    first.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    const second = MockWebSocket.instances[1];
    second.open();
    second.message({ event: "connected", data: {} });
    expect(second.sent.filter((message) => message.event === "room:subscribe")).toEqual([
      { event: "room:subscribe", data: { roomId, deviceId } },
    ]);

    client.unsubscribeRoom(roomId);
    expect(second.sent.at(-1)).toEqual({ event: "room:unsubscribe", data: { roomId } });
    client.disconnect();
  });

  it("retains desired room subscription when requested before the socket is ready", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { WebSocketClient } = await import("./WebSocketClient");
    const client = WebSocketClient.getInstance();
    const roomId = "room-456";
    const deviceId = "fedcba9876543210fedcba9876543210";

    client.connect("access-token");
    client.subscribeRoom(roomId, deviceId);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message({ event: "connected", data: {} });

    expect(socket.sent.filter((message) => message.event === "room:subscribe")).toEqual([
      { event: "room:subscribe", data: { roomId, deviceId } },
    ]);
    client.disconnect();
  });
});
