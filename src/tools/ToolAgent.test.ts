import { describe, expect, it, vi } from 'vitest';
import { AgentMaxTurnsError, type ModelClientOptions } from '@packages/mica-agent/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { ToolAgent } from './ToolAgent.js';

describe('ToolAgent', () => {
  it('runs a synchronous child agent with the selected subagent tool filter and inherited effort', async () => {
    const { runtime, createSubAgent, query } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    const result = await tool.execute({
      description: 'inspect files',
      subagent_type: 'Explore',
      prompt: 'Find the config loader.',
    });

    expect(query).toHaveBeenCalledWith('Find the config loader.', { maxTurns: 20, signal: undefined });
    expect(result).toContain('Subagent: Explore');
    expect(result).toContain('child result');

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.tools).toBe(true);
    expect(options.effort).toBe('medium');
    expect(options.toolFilter?.('read_file')).toBe(true);
    expect(options.toolFilter?.('write_file')).toBe(false);
    expect(options.toolFilter?.('Agent')).toBe(false);
  });

  it('lets the parent agent override effort explicitly', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await tool.execute({ description: 'hard task', prompt: 'Do it.', effort: 'high' });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.effort).toBe('high');
  });

  it('blocks nested Agent calls for the general-purpose subagent', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await tool.execute({ description: 'general task', prompt: 'Do the task.' });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.toolFilter?.('read_file')).toBe(true);
    expect(options.toolFilter?.('Agent')).toBe(false);
  });

  it('fails closed for an unknown subagent type', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await expect(tool.execute({ description: 'typo', prompt: 'Do it.', subagent_type: 'Explroe' })).rejects.toThrow(
      'Unknown subagent_type: Explroe',
    );
    expect(createSubAgent).not.toHaveBeenCalled();
  });

  it('tracks, reads, and lists a completed background task', async () => {
    const deferred = createDeferred<string>();
    const query = vi.fn(() => deferred.promise);
    const { runtime } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);

    const started = await tool.execute({
      description: 'inspect files',
      prompt: 'Find the config loader.',
      run_in_background: true,
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1];

    expect(taskId).toBeTruthy();
    expect(started).toContain('已在后台启动');
    expect(await tool.execute({ operation: 'list' })).toContain('"status": "running"');
    expect(await tool.execute({ operation: 'read', task_id: taskId })).toContain('status: running');

    deferred.resolve('child result');
    await flushAsyncWork();

    const completed = await tool.execute({ operation: 'read', task_id: taskId });
    expect(completed).toContain('status: completed');
    expect(completed).toContain('child result');
    expect(query).toHaveBeenCalledWith('Find the config loader.', {
      maxTurns: 30,
      signal: expect.any(AbortSignal),
    });
  });

  it('reports failed background tasks and preserves partial results from maxTurns', async () => {
    const query = vi.fn(async () => {
      throw new AgentMaxTurnsError(30, 'partial child result');
    });
    const { runtime } = createRuntimeStub(query);
    const tool = new ToolAgent(runtime, new SubagentTaskManager());
    const started = await tool.execute({
      description: 'bounded task',
      prompt: 'Keep investigating.',
      run_in_background: true,
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1];
    await flushAsyncWork();

    const failed = await tool.execute({ operation: 'read', task_id: taskId });

    expect(failed).toContain('status: failed');
    expect(failed).toContain('partial child result');
    expect(failed).toContain('maximum of 30 turns');
  });

  it('kills a background task with its independent signal', async () => {
    let childSignal: AbortSignal | undefined;
    const query = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
      childSignal = options?.signal;
      return new Promise<string>(() => undefined);
    });
    const { runtime } = createRuntimeStub(query);
    const tool = new ToolAgent(runtime, new SubagentTaskManager());
    const started = await tool.execute({
      description: 'long task',
      prompt: 'Keep working.',
      run_in_background: true,
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1];
    await flushAsyncWork();

    const killed = await tool.execute({ operation: 'kill', task_id: taskId });

    expect(killed).toContain('status: killed');
    expect(childSignal?.aborted).toBe(true);
  });
});

function createRuntimeStub(query = vi.fn(async () => 'child result')) {
  const createSubAgent = vi.fn((_: ModelClientOptions) => ({ query, usageHistory: [] }));
  const createClientOptions = vi.fn((overrides: Partial<ModelClientOptions> = {}) => ({
    model: 'parent-model',
    effort: 'medium' as const,
    provider: {
      id: 'test-provider',
      api_base: 'https://example.com/v1',
      protocol: 'openai_responses' as const,
    },
    ...overrides,
  }));
  const runtime = {
    createSubAgent,
    createClientOptions,
  } as unknown as AgentRuntime;
  return { runtime, createSubAgent, createClientOptions, query };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
