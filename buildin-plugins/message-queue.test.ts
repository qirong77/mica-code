import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import setupMessageQueue from './message-queue.js';

describe('message-queue', () => {
  it('queues busy input for the event owner and defaults to after-turn delivery', async () => {
    const owner = { id: 'owner' };
    const activeOwner = { id: 'active-owner' };
    const harness = createHarness({ busyOwner: owner });
    const input = micaRuntime.createRuntimeInput('background follow-up');

    const result = await harness.hooks.guard('input:received', {
      input,
      isCommand: false,
      owner,
    });

    expect(result).toMatchObject({ handled: true, blocked: false, reason: 'queued' });
    expect(harness.queue.enqueue).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ ...input, queueMode: 'after_turn' }),
    );
    expect(harness.queue.enqueue).not.toHaveBeenCalledWith(activeOwner, input);
    expect(harness.queues.get(owner)).toEqual([expect.objectContaining({ ...input, queueMode: 'after_turn' })]);
    expect(harness.queues.get(activeOwner)).toBeUndefined();
    expect(harness.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'queue:changed',
          pendingInputs: [expect.objectContaining({ ...input, queueMode: 'after_turn' })],
          owner,
        }),
        expect.objectContaining({
          type: 'notification',
          owner,
        }),
      ]),
    );
  });

  it('preserves explicit after-iteration delivery', async () => {
    const owner = { id: 'owner' };
    const harness = createHarness({ busyOwner: owner });
    const input = micaRuntime.createRuntimeInput('iteration follow-up', 'ui', { queueMode: 'after_iteration' });

    const result = await harness.hooks.guard('input:received', {
      input,
      isCommand: false,
      owner,
    });

    expect(result).toMatchObject({ handled: true, blocked: false, reason: 'queued' });
    expect(harness.queue.enqueue).toHaveBeenCalledWith(owner, input);
    expect(harness.queues.get(owner)).toEqual([input]);
  });

  it('does not append a second pending input for the same owner', async () => {
    const owner = { id: 'owner' };
    const firstInput = micaRuntime.createRuntimeInput('first follow-up');
    const harness = createHarness({ busyOwner: owner, initialQueues: [[owner, [firstInput]]] });
    const input = micaRuntime.createRuntimeInput('second follow-up', 'ui', { queueMode: 'after_turn' });

    const result = await harness.hooks.guard('input:received', {
      input,
      isCommand: false,
      owner,
    });

    expect(result).toMatchObject({ handled: true, blocked: false, reason: 'queue_full' });
    expect(harness.queue.enqueue).toHaveBeenCalledWith(owner, input);
    expect(harness.queues.get(owner)).toEqual([firstInput]);
    expect(harness.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification',
          level: 'warn',
          owner,
        }),
      ]),
    );
  });

  it('dequeues and submits after-turn input for the turn owner', async () => {
    const owner = { id: 'owner' };
    const next = micaRuntime.createRuntimeInput('queued follow-up', 'ui', {
      queueMode: 'after_turn',
      displayText: 'Queued follow-up',
    });
    const harness = createHarness({ initialQueues: [[owner, [next]]] });

    await harness.hooks.emit('turn:after', {
      owner,
      input: micaRuntime.createRuntimeInput('current turn'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });

    expect(harness.queue.dequeue).toHaveBeenCalledWith(owner);
    expect(harness.queue.list).toHaveBeenCalledWith(owner);
    expect(harness.published).toContainEqual({ type: 'queue:changed', pendingInputs: [], owner });
    expect(harness.submit).toHaveBeenCalledWith(next.text, {
      source: 'plugin',
      displayText: next.displayText,
    });
  });
});

function createHarness(
  options: {
    busyOwner?: unknown;
    initialQueues?: Array<[unknown, RuntimeInput[]]>;
  } = {},
) {
  const hooks = new micaPlugin.HookRegistry();
  const queues = new Map<unknown, RuntimeInput[]>(options.initialQueues ?? []);
  const published: unknown[] = [];
  const submit = vi.fn(async () => ({ accepted: true }));
  const queue = {
    isBusy: vi.fn((owner: unknown) => owner === options.busyOwner),
    enqueue: vi.fn((owner: unknown, input: RuntimeInput) => {
      if ((queues.get(owner)?.length ?? 0) >= 1) return false;
      queues.set(owner, [...(queues.get(owner) ?? []), input]);
      return true;
    }),
    dequeue: vi.fn((owner: unknown) => queues.get(owner)?.shift() ?? null),
    list: vi.fn((owner: unknown) => [...(queues.get(owner) ?? [])]),
  };

  setupMessageQueue({
    pluginId: 'test.messageQueue',
    hooks,
    runtime: { queue, submit },
    events: {
      publish: vi.fn((event: unknown) => published.push(event)),
    },
    onDispose: vi.fn(),
  } as unknown as PluginContext);

  return { hooks, published, queue, queues, submit };
}
