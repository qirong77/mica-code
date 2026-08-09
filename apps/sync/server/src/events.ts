import type { NewSyncEvent, SyncEvent } from '@packages/mica-sync-protocol/index.js';

export type { NewSyncEvent, SyncEvent } from '@packages/mica-sync-protocol/index.js';

export type EventListener = (event: SyncEvent) => void;

const MAX_BUFFERED_EVENTS = 500;
const KEY_SEPARATOR = '/';

function keyOf(machineId: string, sessionId: string): string {
  return `${machineId}${KEY_SEPARATOR}${sessionId}`;
}

/** Per-session in-memory event buffer with SSE-style subscriptions. */
export class EventHub {
  private readonly buffers = new Map<string, SyncEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  publish(machineId: string, sessionId: string, event: NewSyncEvent): SyncEvent {
    const key = keyOf(machineId, sessionId);
    const buffer = this.buffers.get(key) ?? [];
    const seq = (buffer.at(-1)?.seq ?? 0) + 1;
    const full: SyncEvent = { ...event, seq, ts: Date.now() };
    buffer.push(full);
    if (buffer.length > MAX_BUFFERED_EVENTS) buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    this.buffers.set(key, buffer);

    const listeners = this.listeners.get(key);
    if (listeners) for (const listener of listeners) listener(full);
    return full;
  }

  latestSeq(machineId: string, sessionId: string): number {
    return this.buffers.get(keyOf(machineId, sessionId))?.at(-1)?.seq ?? 0;
  }

  /**
   * Sequence number of the last published `session` snapshot event for this
   * conversation. The web client connects SSE from this point after fetching
   * the detail snapshot, so old buffered events (already reflected in the
   * snapshot) are not replayed and cannot duplicate rendered messages.
   */
  snapshotSeq(machineId: string, sessionId: string): number {
    const buffer = this.buffers.get(keyOf(machineId, sessionId));
    if (!buffer) return 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].type === 'session') return buffer[i].seq;
    }
    return 0;
  }

  /** Subscribe to future events; replay buffered events after `since` first. */
  subscribe(machineId: string, sessionId: string, since: number, listener: EventListener): () => void {
    const key = keyOf(machineId, sessionId);
    const buffer = this.buffers.get(key) ?? [];
    for (const event of buffer) {
      if (event.seq > since) listener(event);
    }
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }
}
