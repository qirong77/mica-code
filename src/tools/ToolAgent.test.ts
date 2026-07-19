import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMaxTurnsError, type ModelClientOptions } from '@packages/mica-agent/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { ToolAgent } from './ToolAgent.js';

describe('ToolAgent', () => {
  afterEach(() => vi.useRealTimers());

  it('runs a synchronous child agent with the selected subagent tool filter and inherited effort', async () => {
    const { runtime, createSubAgent, query } = createRuntimeStub();
    const taskManager = new SubagentTaskManager();
    const listener = vi.fn();
    taskManager.subscribe(listener);
    const tool = new ToolAgent(runtime, taskManager);

    const result = await tool.execute({
      description: 'inspect files',
      subagent_type: 'Explore',
      prompt: 'Find the config loader.',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('Find the config loader.'), expect.objectContaining({
      maxTurns: 50,
      signal: expect.any(AbortSignal),
      onIterationComplete: expect.any(Function),
    }));
    const firstCall = query.mock.calls.at(0) as unknown as [string, unknown] | undefined;
    expect(firstCall?.[0]).toContain('<delegated-context>');
    expect(result).toContain('Subagent: Explore');
    expect(result).toContain('## Summary');
    expect(result).toContain('child result');
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ description: 'inspect files', status: 'running', subagent_type: 'Explore' }),
      runtime,
    );
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }), runtime);
    expect(taskManager.list(runtime)).toEqual([
      expect.objectContaining({
        description: 'inspect files',
        prompt: 'Find the config loader.',
        context_mode: 'brief',
        status: 'completed',
      }),
    ]);

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
    expect(query).toHaveBeenCalledWith(expect.stringContaining('Find the config loader.'), expect.objectContaining({
      maxTurns: 50,
      signal: expect.any(AbortSignal),
      onIterationComplete: expect.any(Function),
    }));
  });

  it('reports failed background tasks and preserves partial results from maxTurns', async () => {
    const query = vi.fn(async () => {
      throw new AgentMaxTurnsError(50, 'partial child result');
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
    expect(failed).toContain('maximum of 50 turns');
  });

  it('requires owned_paths for Implementer and injects them into tool context', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await expect(
      tool.execute({
        description: 'write code',
        prompt: 'Implement the change.',
        subagent_type: 'Implementer',
      }),
    ).rejects.toThrow('requires non-empty owned_paths');

    await tool.execute({
      description: 'write code',
      prompt: 'Implement the change.',
      subagent_type: 'Implementer',
      owned_paths: ['src/tools'],
      context_mode: 'none',
    });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.toolContext).toMatchObject({
      ownedPaths: [expect.stringContaining('src/tools')],
    });
  });

  it('awaits background tasks until completion', async () => {
    const deferred = createDeferred<string>();
    const query = vi.fn(() => deferred.promise);
    const { runtime } = createRuntimeStub(query);
    const tool = new ToolAgent(runtime, new SubagentTaskManager());
    const started = await tool.execute({
      description: 'bg',
      prompt: 'Work',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1];
    expect(taskId).toBeTruthy();

    const awaiting = tool.execute({ operation: 'await', task_id: taskId });
    deferred.resolve('done');
    const result = await awaiting;
    expect(result).toContain('status: completed');
    expect(result).toContain('done');
  });

  it('run_many executes dependency waves and join summarizes results', async () => {
    const query = vi.fn(async (prompt: string) => `result for ${prompt}`);
    const { runtime } = createRuntimeStub(query);
    const tool = new ToolAgent(runtime, new SubagentTaskManager());

    const many = await tool.execute({
      operation: 'run_many',
      max_parallel: 2,
      tasks: [
        {
          id: 'explore',
          description: 'explore ui',
          prompt: 'Explore UI',
          subagent_type: 'Explore',
          context_mode: 'none',
        },
        {
          id: 'impl',
          description: 'implement ui',
          prompt: 'Implement UI',
          subagent_type: 'Implementer',
          owned_paths: ['packages/mica-ui'],
          depends_on: ['explore'],
          context_mode: 'none',
        },
      ],
    });

    expect(many).toContain('run_many finished 2 task(s)');
    expect(many).toContain('## explore: explore ui');
    expect(many).toContain('## impl: implement ui');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('starts proposal subagents without write tools', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);
    await tool.execute({
      description: 'propose patch',
      prompt: 'Return a patch only.',
      subagent_type: 'Proposal',
      owned_paths: ['src/tools'],
      context_mode: 'none',
    });
    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.toolFilter?.('write_file')).toBe(false);
    expect(options.toolFilter?.('apply_patch')).toBe(false);
    expect(options.toolContext).toMatchObject({ writeMode: 'proposal' });
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

  it('derives one iteration activity locally without another agent query', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const query = vi.fn((_prompt: string, _options?: { onIterationComplete?: () => unknown }) => deferred.promise);
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'inspect rules',
      prompt: 'Inspect the rules module.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('等待模型响应');
    child.onThinking?.('先看目录结构\n再检查规则编辑器相关代码');
    vi.advanceTimersByTime(100);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('再检查规则编辑器相关代码');

    child.onText?.('我会先检查规则编辑器和接口定义。\n我将接着读取关键实现。');
    vi.advanceTimersByTime(100);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('接着读取关键实现。');

    child.onToolCall?.('grep_search', '{"pattern":"RuleEditor","path":"packages/rules"}', 'tool-1');
    child.onToolCall?.('read_file', '{"file_path":"packages/rules/RuleEditor.tsx"}', 'tool-2');
    child.onToolCall?.('read_file', '{"file_path":"packages/rules/index.ts"}', 'tool-3');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('接着读取关键实现。');
    vi.advanceTimersByTime(100);

    const summary = taskManager.get(taskId, runtime)?.activities?.[0]?.summary ?? '';
    expect(summary).toContain('搜索代码');
    expect(summary).toContain('读取文件');
    expect(summary).toContain('等2个');
    expect(taskManager.get(taskId, runtime)?.activities).toEqual([
      expect.objectContaining({ id: 'current-iteration' }),
    ]);
    expect(query).toHaveBeenCalledTimes(1);

    child.onToolResult?.('read_file', 'file contents', 'tool-2');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe(summary);

    const queryOptions = query.mock.calls[0]?.[1] as { onIterationComplete?: () => unknown } | undefined;
    queryOptions?.onIterationComplete?.();
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe(summary);
    expect(query).toHaveBeenCalledTimes(1);

    child.onThinking?.('继续核对键盘事件');
    vi.advanceTimersByTime(100);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('继续核对键盘事件');

    deferred.resolve('done');
    await flushAsyncWork();
  });
});

function createRuntimeStub(query = vi.fn(async () => 'child result')) {
  const child: {
    query: typeof query;
    usageHistory: [];
    onText?: (text: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: string, id?: string) => void;
    onToolResult?: (name: string, result: string, id?: string) => void;
  } = { query, usageHistory: [] };
  const createSubAgent = vi.fn((_: ModelClientOptions) => child);
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
    taskOwnerId: 'owner-1',
    getSnapshot: () => ({ messages: [{ role: 'user', content: 'parent history context' }] }),
  } as unknown as AgentRuntime;
  return { runtime, child, createSubAgent, createClientOptions, query };
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
