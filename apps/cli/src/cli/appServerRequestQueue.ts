import { AsyncLocalStorage } from 'node:async_hooks';

/** Preserve mutation order; only explicit read-only RPCs can pass their writer's maintenance. */
export class AppServerRequestQueue {
  private readonly pending: { readOnly: boolean; run: () => Promise<void> }[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  private readonly owners = new AsyncLocalStorage<symbol>();
  private readonly maintenance = new Map<symbol | null, number>();
  private readers = 0;
  private writer: symbol | null = null;

  constructor(private readonly maxReaders = 4) {
    if (!Number.isInteger(maxReaders) || maxReaders < 1) throw new Error('maxReaders must be positive');
  }

  enqueue<T>(task: () => T | Promise<T>, { readOnly = false } = {}): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({
        readOnly,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
    this.pump();
    return result;
  }

  /**
   * A detached maintenance task must never permit reads alongside an unrelated
   * active writer. It also blocks later writers and participates in EOF drain.
   * task's synchronous prefix (including active notification) runs before reads
   * are released; its finally (inactive notification) runs before later writes.
   */
  async withReadOnlyBypass<T>(task: () => T | Promise<T>): Promise<T> {
    const owner = this.owners.getStore() ?? null;
    this.maintenance.set(owner, (this.maintenance.get(owner) ?? 0) + 1);
    try {
      const result = task();
      this.pump();
      return await result;
    } finally {
      const remaining = this.maintenance.get(owner)! - 1;
      if (remaining) this.maintenance.set(owner, remaining);
      else this.maintenance.delete(owner);
      this.pump();
    }
  }

  /** EOF/shutdown waits for accepted RPCs and detached maintenance before disposal. */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return !this.writer && this.readers === 0 && this.pending.length === 0 && this.maintenance.size === 0;
  }

  private pump(): void {
    if (this.writer && !(this.maintenance.size === 1 && this.maintenance.has(this.writer))) return;
    // An earlier queued mutation is always a barrier, even during maintenance.
    while (this.pending[0]?.readOnly && this.readers < this.maxReaders) {
      this.start(this.pending.shift()!);
    }
    if (!this.writer && this.readers === 0 && this.maintenance.size === 0 && this.pending.length) {
      this.start(this.pending.shift()!);
    }
    if (this.isIdle()) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private start(job: { readOnly: boolean; run: () => Promise<void> }): void {
    const owner = Symbol();
    if (job.readOnly) this.readers += 1;
    else this.writer = owner;
    void this.owners.run(owner, job.run).finally(() => {
      if (job.readOnly) this.readers -= 1;
      else this.writer = null;
      this.pump();
    });
  }
}
