/**
 * EventDispatcher — a typed, subscription-based event bus.
 *
 * Components subscribe to specific event types and are notified when
 * an event of that type arrives via the WebSocket.  No component
 * touches the raw WebSocket directly.
 *
 * Usage:
 *   const dispatch = EventDispatcher.getInstance();
 *   const unsub = dispatch.on("presence:online", (data) => { ... });
 *   // later:
 *   unsub();
 */

type Listener = (data: any) => void;

export class EventDispatcher {
  private static _instance: EventDispatcher;

  /** event -> Set<listener> */
  private readonly _listeners = new Map<string, Set<Listener>>();

  /** event -> last data (for late subscribers that want initial state) */
  private readonly _lastData = new Map<string, any>();

  static getInstance(): EventDispatcher {
    if (!EventDispatcher._instance) {
      EventDispatcher._instance = new EventDispatcher();
    }
    return EventDispatcher._instance;
  }

  // -------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------

  /**
   * Subscribe to an event type.
   *
   * @returns An unsubscribe function.
   */
  on(event: string, listener: Listener): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(listener);

    // If we have cached data for this event, immediately call the listener
    if (this._lastData.has(event)) {
      try {
        listener(this._lastData.get(event));
      } catch {
        // Silently ignore listener errors
      }
    }

    return () => {
      this._listeners.get(event)?.delete(listener);
    };
  }

  /**
   * Subscribe to an event type **once**.
   */
  once(event: string, listener: Listener): () => void {
    const wrapper: Listener = (data) => {
      unsub();
      try {
        listener(data);
      } catch {
        // Silently ignore
      }
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  /**
   * Remove all listeners for an event type.
   */
  off(event: string): void {
    this._listeners.delete(event);
  }

  // -------------------------------------------------------------------
  // Dispatching
  // -------------------------------------------------------------------

  /**
   * Dispatch an event to all subscribers.
   */
  dispatch(event: string, data: any): void {
    this._lastData.set(event, data);
    const listeners = this._listeners.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(data);
      } catch {
        // Silently ignore listener errors
      }
    }
  }

  /**
   * Dispatch a raw WebSocket message (parsed JSON).
   */
  dispatchRaw(payload: { event: string; data: any }): void {
    this.dispatch(payload.event, payload.data);
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /**
   * Clear all subscriptions and cached data (useful on logout).
   */
  reset(): void {
    this._listeners.clear();
    this._lastData.clear();
  }
}
