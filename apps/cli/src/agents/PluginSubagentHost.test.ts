import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMaxTurnsError } from '@packages/mica-agent/index.js';
import type { PluginSubagentApi, PluginSubagentType } from '@packages/mica-plugin/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { createPluginSubagentHost } from './PluginSubagentHost.js';
import { SubagentTaskManager } from './SubagentTaskManager.js';

type QueryOptions = {
  signal?: AbortSignal;
  maxTurns?: number;
  onIterationComplete?: () => void;
};

type QueryImpl = (prompt: string, options?: QueryOptions) => Promise<string>;

type PendingQuery = {
  query: QueryImpl;
  prompts: string[];
  /** Settle the oldest query that has not been settled yet. */
  settle(result: string): void;
  fail(error: unknown): void;
};

/**
 * A subagent query that stays pending until the test settles it, and rejects on
 * abort so the host's kill path always reaches its `finally`.
 */
function createPendingQuery(): PendingQuery {
  const prompts: string[] = [];
  const open = new Map<number, { resolve: (value: string) => void; reject: (error: unknown) => void }>();
  let nextId = 0;

  const query: QueryImpl = (prompt, options = {}) => {
    prompts.push(prompt);
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      open.set(id, { resolve, reject });
      if (!options.signal) return;
      const onAbort = () => {
        open.delete(id);
        reject(new Error('aborted'));
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  const takeOldest = () => {
    const oldest = [...open.entries()].at(0);
    if (!oldest) throw new Error('the subagent query has not started yet');
    open.delete(oldest[0]);
    return oldest[1];
  };

  return {
    query,
    prompts,
    settle: (result) => takeOldest().resolve(result),
    fail: (error) => takeOldest().reject(error),
  };
}

function exploreType(overrides: Partial<PluginSubagentType> = {}): PluginSubagentType {
  return {
    name: 'Explore',
    description: 'Read-only investigation',
    systemPrompt: 'Explore the codebase and report findings.',
    ...overrides,
  };
}

function createRuntimeStub(options: { query?: QueryImpl; messages?: unknown[]; taskOwnerId?: string } = {}) {
  const query = options.query ?? (async () => 'subagent output');
  const usageHistory: unknown[] = [];
  const recordSubagentUsage = vi.fn();
  const createSubAgent = vi.fn(() => ({ query, usageHistory }));
  const runtime = {
    taskOwnerId: options.taskOwnerId ?? 'agent-runtime-under-test',
    createSubAgent,
    // Mirrors AgentRuntime.createClientOptions: undefined overrides are dropped, not spread in.
    createClientOptions: (overrides: Record<string, unknown> = {}) => {
      const merged: Record<string, unknown> = {
        provider: { id: 'test-provider', protocol: 'chat', supportsEffort: true, contextWindowSize: 200_000 },
        model: 'test-model',
        effort: 'medium',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) merged[key] = value;
      }
      return merged;
    },
    recordSubagentUsage,
    getSnapshot: () => ({ messages: options.messages ?? [] }),
  };
  return { runtime: runtime as unknown as AgentRuntime, createSubAgent, recordSubagentUsage };
}

function fakePath(...segments: string[]): string {
  return join(tmpdir(), 'mica-plugin-subagent-host', ...segments);
}

const taskManagers: SubagentTaskManager[] = [];

function createHarness(stubOptions: Parameters<typeof createRuntimeStub>[0] = {}) {
  const taskManager = new SubagentTaskManager();
  taskManagers.push(taskManager);
  const stub = createRuntimeStub(stubOptions);
  const host = createPluginSubagentHost({ defaultAgent: stub.runtime, taskManager });
  const api: PluginSubagentApi = host.forPlugin('test-plugin');
  return {
    api,
    host,
    taskManager,
    runtime: stub.runtime,
    createSubAgent: stub.createSubAgent,
    recordSubagentUsage: stub.recordSubagentUsage,
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

afterEach(async () => {
  while (taskManagers.length > 0) await taskManagers.pop()?.stop();
});

describe('PluginSubagentHost type registry', () => {
  it('registers types per plugin, rejects duplicates, and disposes one at a time', () => {
    const harness = createHarness();
    const disposeExplore = harness.api.registerType(exploreType());
    harness.api.registerType(exploreType({ name: 'Implementer' }));

    expect(harness.api.listTypes().map((type) => type.name)).toEqual(['Explore', 'Implementer']);
    expect(() => harness.api.registerType(exploreType())).toThrow(/already registered/);
    // Names are matched case-insensitively, so " explore " is the same type.
    expect(() => harness.api.registerType(exploreType({ name: ' explore ' }))).toThrow(/already registered/);
    expect(harness.api.listTypes()).toHaveLength(2);

    disposeExplore.dispose();

    expect(harness.api.listTypes().map((type) => type.name)).toEqual(['Implementer']);
  });

  it('keeps one plugin blind to another plugin types', () => {
    const harness = createHarness();
    harness.api.registerType(exploreType());

    const other = harness.host.forPlugin('other-plugin');

    expect(other.listTypes()).toEqual([]);
    expect(other.getType('Explore')).toBeNull();
    expect(harness.api.listTypes()).toHaveLength(1);
  });

  it('resolves type names ignoring case and surrounding whitespace', () => {
    const harness = createHarness();
    harness.api.registerType(exploreType());

    expect(harness.api.getType(' explore ')?.name).toBe('Explore');
    expect(harness.api.getType('EXPLORE')?.name).toBe('Explore');
    expect(harness.api.getType('nope')).toBeNull();

    const resolved = harness.api.getType('Explore');
    resolved!.description = 'mutated by the caller';
    expect(harness.api.getType('Explore')?.description).toBe('Read-only investigation');
  });
});

describe('PluginSubagentHost run', () => {
  it('classifies maintenance before publishing the first task update and still records usage', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    harness.api.registerType(exploreType({ activity: 'maintenance' }));
    const seen: string[] = [];
    const subscription = harness.taskManager.subscribe((task) => { seen.push(task.activity ?? 'delegation'); });
    const request = harness.api.run({ description: 'maintain state', prompt: 'update internal notes' });
    await flushAsyncWork();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(value => value === 'maintenance')).toBe(true);
    pending.settle('done');
    const result = await request;
    expect(result.status).toBe('completed');
    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(harness.taskManager.get(result.taskId, harness.runtime)).toMatchObject({ activity: 'maintenance' });
    subscription();
  });

  it('runs a subagent and records its usage once', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({
      query: pending.query,
      messages: [{ role: 'user', content: 'earlier question about the router' }],
    });
    harness.api.registerType(exploreType());

    const running = harness.api.run({ type: 'Explore', description: 'look around', prompt: 'inspect the repo' });
    await flushAsyncWork();

    expect(harness.createSubAgent).toHaveBeenCalledTimes(1);
    expect(pending.prompts).toHaveLength(1);
    expect(pending.prompts[0]).toContain('inspect the repo');
    // Default context mode (brief) prepends the parent conversation.
    expect(pending.prompts[0]).toContain('earlier question about the router');

    pending.settle('subagent output');
    const result = await running;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('subagent output');
    expect(result.taskId).toMatch(/^agent-task-/);
    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(harness.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: result.taskId,
        subagentType: 'Explore',
        description: 'look around',
        model: 'test-model',
        status: 'completed',
        // 没有发起它的 tool call：这是插件自己起的后台任务，统计页要记到插件名下。
        origin: 'plugin',
        pluginId: 'test-plugin',
      }),
    );
    expect(harness.api.tasks.get(result.taskId)).toMatchObject({
      id: result.taskId,
      type: 'Explore',
      status: 'completed',
      result: 'subagent output',
      model: 'test-model',
      effort: 'medium',
    });
  });

  it('records tool-call delegations as delegations, not as plugin background work', async () => {
    const harness = createHarness();
    harness.api.registerType(exploreType());
    const caller = harness.api.caller({
      agent: harness.runtime,
      taskId: 'parent-task',
      toolCallId: 'call-1',
    }) as NonNullable<ReturnType<typeof harness.api.caller>>;

    const result = await harness.api.run({
      type: 'Explore',
      description: 'delegated run',
      prompt: 'look around',
      caller,
    });

    // 委派本身由插件提供，但这一笔是主对话派出去的活：统计页归到 Delegated，
    // 而不是「插件后台请求」。
    expect(harness.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: result.taskId,
        origin: 'delegation',
        initiatedByCallId: 'call-1',
        subagentType: 'Explore',
      }),
    );
    expect(harness.recordSubagentUsage.mock.calls[0][0]).not.toHaveProperty('pluginId');
  });

  it('returns a failed result instead of throwing when the query fails', async () => {
    const harness = createHarness({
      query: async () => {
        throw new Error('boom');
      },
    });
    harness.api.registerType(exploreType());

    const result = await harness.api.run({ description: 'broken run', prompt: 'do the thing' });

    expect(result.status).toBe('failed');
    expect(result.output).toBe('');
    expect(result.error).toBe('boom');
    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(harness.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: result.taskId, status: 'failed', description: 'broken run' }),
    );
  });

  it('reports a partial result when the subagent hits maxTurns', async () => {
    const harness = createHarness({
      query: async () => {
        throw new AgentMaxTurnsError(3, 'half-way summary');
      },
    });
    harness.api.registerType(exploreType());

    const result = await harness.api.run({ description: 'long run', prompt: 'keep going', maxTurns: 3 });

    expect(result.status).toBe('partial');
    expect(result.output).toBe('half-way summary');
    expect(result.error).toContain('maximum of 3 turns');
    expect(harness.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', subagentType: 'Explore' }),
    );
  });

  it('settles as killed when the caller aborts a running subagent', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    harness.api.registerType(exploreType());
    const controller = new AbortController();

    const running = harness.api.run({
      description: 'cancelled run',
      prompt: 'stop when asked',
      signal: controller.signal,
    });
    await flushAsyncWork();
    expect(pending.prompts).toHaveLength(1);

    controller.abort();
    const result = await running;

    expect(result.status).toBe('killed');
    expect(harness.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'killed', description: 'cancelled run' }),
    );
  });

  it('rejects unknown subagent types before creating a task', async () => {
    const harness = createHarness();
    harness.api.registerType(exploreType());

    await expect(harness.api.run({ type: 'Nope', description: 'x', prompt: 'y' })).rejects.toThrow(
      /Unknown subagent_type/,
    );

    expect(harness.createSubAgent).not.toHaveBeenCalled();
    expect(harness.taskManager.list(harness.runtime)).toEqual([]);
  });

  it('rejects types that require owned paths when none are given', async () => {
    const harness = createHarness();
    harness.api.registerType(exploreType({ requireOwnedPaths: true }));

    await expect(harness.api.run({ description: 'x', prompt: 'y' })).rejects.toThrow(/requires non-empty owned_paths/);
    expect(harness.taskManager.list(harness.runtime)).toEqual([]);
  });

  it('rejects owned paths for a read-only type', async () => {
    const harness = createHarness();
    harness.api.registerType(exploreType({ writeMode: 'none' }));

    await expect(
      harness.api.run({ description: 'x', prompt: 'y', ownedPaths: [fakePath('src', 'a.ts')] }),
    ).rejects.toThrow(/does not accept owned_paths/);
    expect(harness.taskManager.list(harness.runtime)).toEqual([]);
  });
});

describe('PluginSubagentHost background tasks', () => {
  it('starts a background task and reports it through tasks.list', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    harness.api.registerType(exploreType());

    const handle = harness.api.background({ description: 'background run', prompt: 'work in the background' });

    expect(handle.taskId).toMatch(/^agent-task-/);
    expect(harness.api.tasks.list()).toEqual([
      expect.objectContaining({ id: handle.taskId, status: 'running', type: 'Explore', description: 'background run' }),
    ]);

    await flushAsyncWork();
    pending.settle('background output');

    await expect(handle.done).resolves.toMatchObject({ taskId: handle.taskId, status: 'completed' });
    expect(harness.api.tasks.list()).toEqual([
      expect.objectContaining({ id: handle.taskId, status: 'completed', result: 'background output' }),
    ]);
    await expect(handle.done).resolves.toMatchObject({ output: 'background output' });
  });

  it('scopes tasks.list/get to the plugin that spawned them', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    const first = harness.host.forPlugin('plugin-a');
    const second = harness.host.forPlugin('plugin-b');
    first.registerType(exploreType());

    const handle = first.background({ description: 'a task', prompt: 'work' });

    expect(first.tasks.list().map((task) => task.id)).toEqual([handle.taskId]);
    expect(second.tasks.list()).toEqual([]);
    expect(second.tasks.get(handle.taskId)).toBeNull();
    expect(second.tasks.kill(handle.taskId)).toBe(false);

    expect(first.tasks.kill(handle.taskId)).toBe(true);
    await expect(handle.done).resolves.toMatchObject({ status: 'killed' });
  });

  it('waits for a task and never blocks on an already finished one', async () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    harness.api.registerType(exploreType());

    const handle = harness.api.background({ description: 'waited task', prompt: 'work' });
    const waiting = harness.api.tasks.wait([handle.taskId]);
    await flushAsyncWork();
    pending.settle('waited output');

    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ id: handle.taskId, status: 'completed', result: 'waited output' }),
    ]);
    await expect(harness.api.tasks.wait([handle.taskId], { timeoutMs: 10 })).resolves.toEqual([
      expect.objectContaining({ id: handle.taskId, status: 'completed' }),
    ]);
  });
});

describe('PluginSubagentHost caller', () => {
  it('maps a tool context into a spawn caller', () => {
    const harness = createHarness();
    const { runtime } = harness;

    const caller = harness.api.caller({ agent: runtime, taskId: 'task-1', toolCallId: 'call-1' });

    expect(caller).toMatchObject({ taskId: 'task-1', toolCallId: 'call-1' });
    expect(caller?.owner).toBe(runtime);
    expect(Object.keys(caller ?? {})).toEqual(['owner', 'taskId', 'toolCallId']);

    expect(harness.api.caller(undefined)).toBeNull();
    expect(harness.api.caller(null)).toBeNull();
    expect(harness.api.caller('agent')).toBeNull();
    expect(harness.api.caller({})).toBeNull();
    // A plain tool context agent is not an AgentRuntime handle, so it is not forwarded.
    expect(harness.api.caller({ agent: { name: 'not-a-runtime' }, taskId: 'task-2' })).toEqual({ taskId: 'task-2' });
  });
});

describe('PluginSubagentHost path leases', () => {
  it('rejects overlapping owned paths from one owner and allows disjoint ones', () => {
    const pending = createPendingQuery();
    const harness = createHarness({ query: pending.query });
    harness.api.registerType(exploreType({ writeMode: 'owned_paths' }));

    const first = harness.api.background({ description: 'first', prompt: 'edit a', ownedPaths: [fakePath('a')] });

    // Overlap includes containment: claiming a subtree of a running lease conflicts too.
    expect(() =>
      harness.api.background({
        description: 'second',
        prompt: 'edit a again',
        ownedPaths: [fakePath('a', 'b.ts')],
      }),
    ).toThrow(/owned_paths conflict/);

    const disjoint = harness.api.background({ description: 'third', prompt: 'edit c', ownedPaths: [fakePath('c')] });
    expect(disjoint.taskId).not.toBe(first.taskId);
    expect(
      harness.api.tasks
        .list()
        .map((task) => task.id)
        .sort(),
    ).toEqual([first.taskId, disjoint.taskId].sort());

    // Killing a task releases its lease right away, so the same path can be claimed again.
    harness.api.tasks.kill(first.taskId);
    expect(() =>
      harness.api.background({ description: 'retry', prompt: 'edit a', ownedPaths: [fakePath('a')] }),
    ).not.toThrow();
  });
});
