import { toDisposable, type Disposable } from './disposable.js';

type EventKey = string | symbol;
type Listener<T> = (event: T) => void | Promise<void>;

export class TypedEventBus<TEvents extends Record<EventKey, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<TEvents[keyof TEvents]>>>();

  on<K extends keyof TEvents>(type: K, listener: Listener<TEvents[K]>): Disposable {
    const listeners = this.listeners.get(type) ?? new Set<Listener<TEvents[keyof TEvents]>>();
    listeners.add(listener as Listener<TEvents[keyof TEvents]>);
    this.listeners.set(type, listeners);

    return toDisposable(() => {
      listeners.delete(listener as Listener<TEvents[keyof TEvents]>);
    });
  }

  emit<K extends keyof TEvents>(type: K, event: TEvents[K]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      void listener(event);
    }
  }

  async emitAsync<K extends keyof TEvents>(type: K, event: TEvents[K]): Promise<void> {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      await listener(event);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
