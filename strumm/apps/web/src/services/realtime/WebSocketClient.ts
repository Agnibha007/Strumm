/**
 * WebSocketClient — singleton connection manager for the global realtime
 * WebSocket at ``/ws``.
 *
 * Features:
 *   - JWT-authenticated connection (token sent as query param)
 *   - Heartbeat (ping every 30s, timeout after 10s)
 *   - Automatic reconnect with exponential backoff:
 *     0s, 2s, 5s, 10s, 30s (max)
 *   - Restores event subscriptions after reconnect
 *   - Dispatches all events through EventDispatcher
 *
 * Usage:
 *   const client = WebSocketClient.getInstance();
 *   client.connect(token);
 *   // later:
 *   client.disconnect();
 */

import { EventDispatcher } from "./EventDispatcher";
import { PING, PONG, WS_CONNECTED, WS_DISCONNECTED, WS_RECONNECTING } from "./types";
import { apiUrl } from "web/lib/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000; // send ping every 30s
const HEARTBEAT_TIMEOUT_MS = 10_000;  // close if no pong within 10s
const RECONNECT_DELAYS = [0, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONNECT_DELAY = 30_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export class WebSocketClient {
  private static _instance: WebSocketClient;

  private _ws: WebSocket | null = null;
  private _token: string | null = null;
  private _state: ConnectionState = "disconnected";
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Callback fired whenever connection state changes. */
  onStateChange: ((state: ConnectionState) => void) | null = null;

  private readonly _dispatch = EventDispatcher.getInstance();

  static getInstance(): WebSocketClient {
    if (!WebSocketClient._instance) {
      WebSocketClient._instance = new WebSocketClient();
    }
    return WebSocketClient._instance;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === "connected";
  }

  /**
   * Open (or re-open) the WebSocket connection with the given JWT.
   */
  connect(token: string): void {
    this._token = token;

    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return; // already connected or connecting
    }

    this._doConnect();
  }

  /**
   * Gracefully close the WebSocket and stop reconnection.
   */
  disconnect(): void {
    this._token = null;
    this._reconnectAttempt = 0;
    this._clearReconnectTimer();
    this._clearHeartbeat();
    this._closeWs();
    this._setState("disconnected");
  }

  /**
   * Send a JSON message through the WebSocket.
   */
  send(event: string, data?: any): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ event, data }));
    }
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private _setState(state: ConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      this.onStateChange?.(state);
    }
  }

  private _doConnect(): void {
    if (!this._token) return;

    this._setState(this._reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this._closeWs();

    // Build the WS URL from the API base URL
    const baseUrl = apiUrl("").replace(/^http/, "ws").replace(/\/+$/, "");
    const wsUrl = `${baseUrl}/ws?token=${encodeURIComponent(this._token)}`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => this._onOpen();
      ws.onmessage = (event) => this._onMessage(event);
      ws.onclose = () => this._onClose();
      ws.onerror = () => {
        // onclose fires after onerror, so cleanup happens there
      };
      this._ws = ws;
    } catch {
      this._scheduleReconnect();
    }
  }

  private _onOpen(): void {
    this._reconnectAttempt = 0;
    this._setState("connected");
    this._startHeartbeat();

    // Notify the event dispatcher
    this._dispatch.dispatch(WS_CONNECTED, null);

    // Restore listening state if the user was playing
    // (handled by the provider component)
  }

  private _onMessage(event: MessageEvent): void {
    try {
      const payload = JSON.parse(event.data);

      // Handle heartbeat pong
      if (payload.event === PONG) {
        this._clearHeartbeatTimeout();
        return;
      }

      // Handle connected acknowledgement
      if (payload.event === "connected") {
        return;
      }

      // Dispatch to all subscribers
      this._dispatch.dispatchRaw(payload);
    } catch {
      // Ignore malformed messages
    }
  }

  private _onClose(): void {
    this._clearHeartbeat();
    this._ws = null;
    this._setState("disconnected");

    if (this._token) {
      this._scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------

  private _startHeartbeat(): void {
    this._clearHeartbeat();

    // Send ping every 30s
    this._heartbeatTimer = setInterval(() => {
      this.send(PING);
      // If no pong within 10s, assume dead and reconnect
      this._heartbeatTimeout = setTimeout(() => {
        this._closeWs();
        this._scheduleReconnect();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _clearHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._clearHeartbeatTimeout();
  }

  private _clearHeartbeatTimeout(): void {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }

  // -------------------------------------------------------------------
  // Reconnection (exponential backoff)
  // -------------------------------------------------------------------

  private _scheduleReconnect(): void {
    this._clearReconnectTimer();

    const delay = RECONNECT_DELAYS[this._reconnectAttempt] ?? MAX_RECONNECT_DELAY;
    this._reconnectAttempt = Math.min(this._reconnectAttempt + 1, RECONNECT_DELAYS.length);

    this._setState("reconnecting");

    this._reconnectTimer = setTimeout(() => {
      this._doConnect();
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _closeWs(): void {
    if (this._ws) {
      try {
        this._ws.onopen = null;
        this._ws.onmessage = null;
        this._ws.onclose = null;
        this._ws.onerror = null;
        this._ws.close();
      } catch {
        // Ignore close errors
      }
      this._ws = null;
    }
  }
}
