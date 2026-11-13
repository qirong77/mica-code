import { describe, expect, it } from 'vitest';
import { AppServerRequestQueue } from './appServerRequestQueue.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('app-server request scheduling', () => {
  it('keeps ordinary requests serialized while parsing can continue', async () => {
    const queue = new AppServerRequestQueue();
    const gate = deferred();
    const order: string[] = [];
    const a = queue.enqueue(async () => {
      order.push('write');
      await gate.promise;
    });
    const b = queue.enqueue(() => order.push('view'), { readOnly: true });
    const c = queue.enqueue(() => order.push('next-write'));
    await flush();
    expect(order).toEqual(['write']);
    gate.resolve();
    await Promise.all([a, b, c]);
    await queue.drain();
    expect(order).toEqual(['write', 'view', 'next-write']);
  });

  it('serves queued views as soon as their writer opens maintenance', async () => {
    const queue = new AppServerRequestQueue();
    const compact = deferred();
    const order: string[] = [];
    const a = queue.enqueue(async () => {
      order.push('compact-start');
      await queue.withReadOnlyBypass(async () => {
        order.push('active');
        await compact.promise;
        order.push('compact-end');
      });
    });
    const ssh = queue.enqueue(
      () => {
        order.push('ssh');
        return 'ssh-view';
      },
      { readOnly: true },
    );
    const buttons = queue.enqueue(
      () => {
        order.push('buttons');
        return 'button-view';
      },
      { readOnly: true },
    );
    await flush();
    expect(order).toEqual(['compact-start', 'active', 'ssh', 'buttons']);
    compact.resolve();
    await Promise.all([a, ssh, buttons]);
    await queue.drain();
    expect(order).toEqual(['compact-start', 'active', 'ssh', 'buttons', 'compact-end']);
  });

  it('does not let views overtake an earlier queued mutation', async () => {
    const queue = new AppServerRequestQueue();
    const gate = deferred();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      await queue.withReadOnlyBypass(async () => {
        order.push('maintenance');
        await gate.promise;
      });
    });
    const write = queue.enqueue(() => order.push('write'));
    const view = queue.enqueue(() => order.push('view'), { readOnly: true });
    await flush();
    expect(order).toEqual(['maintenance']);
    gate.resolve();
    await Promise.all([first, write, view]);
    await queue.drain();
    expect(order).toEqual(['maintenance', 'write', 'view']);
  });

  it('waits for asynchronous readers before switching session identity', async () => {
    const queue = new AppServerRequestQueue();
    const compact = deferred();
    const reading = deferred();
    let session = 'first';
    const first = queue.enqueue(async () => {
      await queue.withReadOnlyBypass(async () => {
        await compact.promise;
      });
    });
    const view = queue.enqueue(
      async () => {
        const before = session;
        await reading.promise;
        return [before, session];
      },
      { readOnly: true },
    );
    const switchSession = queue.enqueue(() => {
      session = 'second';
    });
    await flush();
    expect(session).toBe('first');
    compact.resolve();
    await first;
    expect(session).toBe('first');
    reading.resolve();
    await expect(view).resolves.toEqual(['first', 'first']);
    await switchSession;
    await queue.drain();
    expect(session).toBe('second');
  });

  it('bounds parallel readers and resumes remaining views without starting writes', async () => {
    const queue = new AppServerRequestQueue(2);
    const compact = deferred();
    const readers = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const first = queue.enqueue(async () => {
      await queue.withReadOnlyBypass(async () => {
        await compact.promise;
      });
    });
    const views = readers.map((gate, i) =>
      queue.enqueue(
        async () => {
          started.push(i);
          await gate.promise;
        },
        { readOnly: true },
      ),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    readers[0]!.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    readers[1]!.resolve();
    readers[2]!.resolve();
    compact.resolve();
    await Promise.all([first, ...views]);
    await queue.drain();
  });

  it('does not let detached maintenance bypass an unrelated active writer', async () => {
    const queue = new AppServerRequestQueue();
    const writerGate = deferred();
    const maintenanceGate = deferred();
    const order: string[] = [];
    const writer = queue.enqueue(async () => {
      order.push('writer-start');
      await writerGate.promise;
      order.push('writer-end');
    });
    await flush();
    const maintenance = queue.withReadOnlyBypass(async () => {
      order.push('maintenance-start');
      await maintenanceGate.promise;
    });
    const view = queue.enqueue(() => order.push('view'), { readOnly: true });
    await flush();
    expect(order).toEqual(['writer-start', 'maintenance-start']);
    expect(await Promise.race([view.then(() => 'done'), flush().then(() => 'pending')])).toBe('pending');
    maintenanceGate.resolve();
    await maintenance;
    expect(order).toEqual(['writer-start', 'maintenance-start']);
    writerGate.resolve();
    await Promise.all([writer, view]);
    await queue.drain();
    expect(order).toEqual(['writer-start', 'maintenance-start', 'writer-end', 'view']);
  });

  it('stops bypassing after maintenance closes and drains detached work', async () => {
    const queue = new AppServerRequestQueue();
    const gate = deferred();
    const order: string[] = [];
    const maintenance = queue.withReadOnlyBypass(async () => {
      order.push('active');
      await gate.promise;
      order.push('inactive');
    });
    const allowed = queue.enqueue(() => order.push('view'), { readOnly: true });
    await allowed;
    const write = queue.enqueue(() => order.push('write'));
    const drain = queue.drain();
    await flush();
    expect(order).toEqual(['active', 'view']);
    gate.resolve();
    await Promise.all([maintenance, write, drain]);
    expect(order).toEqual(['active', 'view', 'inactive', 'write']);
  });

  it('does not poison subsequent work when a reader or writer fails', async () => {
    const queue = new AppServerRequestQueue();
    const one = queue
      .enqueue(() => {
        throw new Error('writer failure');
      })
      .catch((error) => error.message);
    const two = queue
      .enqueue(() => Promise.reject(new Error('reader failure')), { readOnly: true })
      .catch((error) => error.message);
    const three = queue.enqueue(() => 'still usable');
    await expect(one).resolves.toBe('writer failure');
    await expect(two).resolves.toBe('reader failure');
    await expect(three).resolves.toBe('still usable');
    await queue.drain();
  });

  it('drains accepted requests before EOF cleanup and supports more than one waiter', async () => {
    const queue = new AppServerRequestQueue();
    const gate = deferred();
    let finished = false;
    const first = queue.enqueue(() => gate.promise, { readOnly: true });
    const last = queue.enqueue(() => {
      finished = true;
    });
    const drain = queue.drain();
    const alsoDrain = queue.drain();
    await flush();
    expect(finished).toBe(false);
    gate.resolve();
    await Promise.all([first, last, drain, alsoDrain]);
    expect(finished).toBe(true);
    await queue.drain();
  });

  it('rejects invalid reader limits', () => {
    for (const value of [0, -1, 1.5, Infinity]) expect(() => new AppServerRequestQueue(value)).toThrow();
  });
});
