import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMaxTurnsError,
  type AgentUsageRecord,
  type ModelClientOptions,
} from '@packages/mica-agent/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { DEFAULT_SUBAGENT_MAX_TURNS } from '../agents/subagentDefinitions.js';
import { ToolAgent } from './ToolAgent.js';
import { micaTools, MicaTool } from '@packages/mica-tools/index.js';
import { executeProviderToolCalls, throwIfQueryStopped } from '@packages/mica-agent/providers/providerHelpers.js';

describe('ToolAgent', () => {
  afterEach(() => vi.useRealTimers());

  it('only overlaps await/join operations through the registry', () => {
    const { runtime } = createRuntimeStub();
    const tool = new ToolAgent(runtime);
    micaTools.registerRuntime(tool);
    try {
      expect(micaTools.isReadOnly('agent')).toBe(false);
      expect(micaTools.isOverlappable('agent')).toBe(false);
      for (const operation of ['await', 'join']) {
        expect(micaTools.isOverlappable('agent', { operation })).toBe(true);
      }
      for (const operation of [undefined, 'run', 'run_many', 'read', 'list', 'kill']) {
        expect(micaTools.isOverlappable('agent', { operation })).toBe(false);
      }
    } finally {
      micaTools.unregisterRuntime(tool);
    }
  });

  it.each(['await', 'join'])('overlaps a real %s with the following execution tool', async (operation) => {
    const deferred = createDeferred<string>();
    const { runtime } = createRuntimeStub(vi.fn(() => deferred.promise));
    const manager = new SubagentTaskManager();
    const agent = new ToolAgent(runtime, manager);
    const events: string[] = [];
    const executor = new (class extends MicaTool {
      constructor() {
        super('probe_execute', 'Finish child', { type: 'object' });
      }
      async execute(): Promise<string> {
        events.push('executed');
        deferred.resolve('child completed');
        return 'executed';
      }
      onToolUseDisplayText(): string {
        return this.name;
      }
    })();
    micaTools.registerRuntime(agent);
    micaTools.registerRuntime(executor);
    try {
      await agent.execute({ description: 'bg', prompt: 'Work', run_in_background: true, context_mode: 'none' });
      const taskId = manager.list(runtime)[0]!.id;
      const execution = executeProviderToolCalls({
        calls: [
          { name: 'agent', argsText: '{}', parseArgs: () => ({ operation: 'read', task_id: taskId }) },
          { name: 'agent', argsText: '{}', parseArgs: () => ({ operation, task_id: taskId, timeout_ms: 1000 }) },
          { name: executor.name, argsText: '{}', parseArgs: () => ({}) },
        ],
        context: { agent: runtime },
        toolFilter: undefined,
        onToolResult: (name) => {
          if (name === 'agent') events.push('agent-result');
        },
      });
      const results = await execution;
      expect(results[0]?.result).toContain('status: running');
      expect(results[1]?.result).toContain('status: completed');
      expect(results[1]?.result).toContain('child completed');
      expect(results.map((result) => result.name)).toEqual(['agent', 'agent', executor.name]);
      expect(events).toEqual(['agent-result', 'executed', 'agent-result']);
    } finally {
      deferred.resolve('cleanup');
      await flushAsyncWork();
      micaTools.unregisterRuntime(executor);
      micaTools.unregisterRuntime(agent);
    }
  });

  it.each(['await', 'join'])('propagates cancellation after an overlapped %s settles', async (operation) => {
    const deferred = createDeferred<string>();
    const { runtime } = createRuntimeStub(vi.fn(() => deferred.promise));
    const agent = new ToolAgent(runtime, new SubagentTaskManager());
    const controller = new AbortController();
    micaTools.registerRuntime(agent);
    try {
      const started = await agent.execute({
        description: 'bg',
        prompt: 'Work',
        run_in_background: true,
        context_mode: 'none',
      });
      const taskId = started.match(/task_id: (\S+)/)?.[1];
      const execution = executeProviderToolCalls({
        calls: [{ name: 'agent', argsText: '{}', parseArgs: () => ({ operation, task_id: taskId }) }],
        context: { agent: runtime },
        toolFilter: undefined,
        signal: controller.signal,
        onToolCall: () => queueMicrotask(() => controller.abort()),
        checkpoint: () => {
          if (controller.signal.aborted) throw new Error('query cancelled');
        },
      });
      await expect(execution).rejects.toThrow('query cancelled');
    } finally {
      deferred.resolve('cleanup');
      await flushAsyncWork();
      micaTools.unregisterRuntime(agent);
    }
  });

  it.each(['await', 'join'])(
    'cancels pending %s when a checkpoint stops without an external abort',
    async (operation) => {
      const deferred = createDeferred<string>();
      const { runtime } = createRuntimeStub(vi.fn(() => deferred.promise));
      const agent = new ToolAgent(runtime, new SubagentTaskManager());
      let shouldContinue = true;
      const stopper = new (class extends MicaTool {
        constructor() {
          super('probe_stop', 'Stop continuation', { type: 'object' });
        }
        async execute(): Promise<string> {
          shouldContinue = false;
          return 'stopped';
        }
        onToolUseDisplayText(): string {
          return this.name;
        }
      })();
      micaTools.registerRuntime(agent);
      micaTools.registerRuntime(stopper);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const started = await agent.execute({
          description: 'bg',
          prompt: 'Work',
          run_in_background: true,
          context_mode: 'none',
        });
        const taskId = started.match(/task_id: (\S+)/)?.[1];
        const execution = executeProviderToolCalls({
          calls: [
            { name: 'agent', argsText: '{}', parseArgs: () => ({ operation, task_id: taskId }) },
            { name: stopper.name, argsText: '{}', parseArgs: () => ({}) },
          ],
          context: { agent: runtime },
          toolFilter: undefined,
          checkpoint: () => throwIfQueryStopped({ shouldContinue: () => shouldContinue }),
        });
        const outcome = await Promise.race([
          execution.then(
            () => 'completed',
            (error: Error) => error.name,
          ),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), 1000);
          }),
        ]);
        deferred.resolve('cleanup');
        await execution.catch(() => {});
        expect(outcome).toBe('AbortError');
      } finally {
        clearTimeout(timer);
        deferred.resolve('cleanup');
        await flushAsyncWork();
        micaTools.unregisterRuntime(stopper);
        micaTools.unregisterRuntime(agent);
      }
    },
  );

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

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('Find the config loader.'),
      expect.objectContaining({
        maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
        signal: expect.any(AbortSignal),
        onIterationComplete: expect.any(Function),
      }),
    );
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
    expect(options.toolFilter?.('agent')).toBe(false);
  });

  it('lets the parent agent override effort explicitly', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await tool.execute({ description: 'hard task', prompt: 'Do it.', effort: 'high' });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.effort).toBe('high');
  });

  it('records completed subagent usage into the parent runtime', async () => {
    const { runtime, child, recordSubagentUsage } = createRuntimeStub();
    const tool = new ToolAgent(runtime);
    child.usageHistory.push({
      provider: 'openai_responses',
      turnId: 1,
      requestIndex: 1,
      messageCount: 3,
      model: 'child-model',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      paidTokenRate: 1,
    });

    await tool.execute({
      description: 'inspect files',
      subagent_type: 'Explore',
      prompt: 'Find the config loader.',
    });

    expect(recordSubagentUsage).toHaveBeenCalledTimes(1);
    const record = recordSubagentUsage.mock.calls[0]?.[0] as {
      taskId: string;
      subagentType: string;
      description: string;
      effort: string;
      status: string;
      startedAt: string;
      finishedAt: string;
      requests: AgentUsageRecord[];
      summary: { records: number; inputTokens: number; outputTokens: number };
    };
    expect(record.taskId).toBeTruthy();
    expect(record.subagentType).toBe('Explore');
    expect(record.description).toBe('inspect files');
    expect(record.effort).toBe('medium');
    expect(record.status).toBe('completed');
    expect(record.startedAt).toBeTruthy();
    expect(record.finishedAt).toBeTruthy();
    expect(record.requests).toHaveLength(1);
    expect(record.requests[0]).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(record.summary).toMatchObject({ records: 1, inputTokens: 100, outputTokens: 20 });
  });

  it('records failed and partial subagent usage', async () => {
    const failingQuery = vi.fn(async () => {
      throw new Error('boom');
    });
    const { runtime: failedRuntime, recordSubagentUsage: recordFailed } = createRuntimeStub(failingQuery);
    const failedTool = new ToolAgent(failedRuntime);
    await expect(failedTool.execute({ description: 'x', prompt: 'Do it.' })).rejects.toThrow('boom');
    expect(recordFailed).toHaveBeenCalledTimes(1);
    expect(recordFailed.mock.calls[0]?.[0]?.status).toBe('failed');

    const maxTurnsQuery = vi.fn(async () => {
      throw new AgentMaxTurnsError(50, 'partial child result');
    });
    const { runtime: partialRuntime, recordSubagentUsage: recordPartial } = createRuntimeStub(maxTurnsQuery);
    const partialTool = new ToolAgent(partialRuntime);
    const partialResult = await partialTool.execute({ description: 'bounded', prompt: 'Keep going.' });
    expect(partialResult).toContain('partial child result');
    expect(recordPartial).toHaveBeenCalledTimes(1);
    expect(recordPartial.mock.calls[0]?.[0]?.status).toBe('partial');
  });

  it('records background subagent usage on completion', async () => {
    const deferred = createDeferred<string>();
    const query = vi.fn(() => deferred.promise);
    const { runtime, recordSubagentUsage } = createRuntimeStub(query);
    const tool = new ToolAgent(runtime, new SubagentTaskManager());
    const started = await tool.execute({
      description: 'bg task',
      prompt: 'Do it.',
      run_in_background: true,
    });
    expect(started).toContain('已在后台启动');

    deferred.resolve('done');
    await flushAsyncWork();

    expect(recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(recordSubagentUsage.mock.calls[0]?.[0]?.status).toBe('completed');
  });

  it('records the parent tool-call id and parent task id from tool context', async () => {
    const { runtime, recordSubagentUsage } = createRuntimeStub();
    const tool = new ToolAgent(runtime);
    await tool.execute(
      { description: 'nested', prompt: 'Do it.' },
      { context: { agent: runtime, taskId: 'parent-task-9', toolCallId: 'call-abc' } },
    );

    const record = recordSubagentUsage.mock.calls[0]?.[0] as { parentTaskId?: string; initiatedByCallId?: string };
    expect(record.parentTaskId).toBe('parent-task-9');
    expect(record.initiatedByCallId).toBe('call-abc');
  });

  it('blocks nested Agent calls for the general-purpose subagent', async () => {
    const { runtime, createSubAgent } = createRuntimeStub();
    const tool = new ToolAgent(runtime);

    await tool.execute({ description: 'general task', prompt: 'Do the task.' });

    const options = createSubAgent.mock.calls[0]?.[0] as ModelClientOptions;
    expect(options.toolFilter?.('read_file')).toBe(true);
    expect(options.toolFilter?.('agent')).toBe(false);
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('Find the config loader.'),
      expect.objectContaining({
        maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
        signal: expect.any(AbortSignal),
        onIterationComplete: expect.any(Function),
      }),
    );
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

  it('tracks model phases, wait time, and compact tool activity without another agent query', async () => {
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

    expect(taskManager.get(taskId, runtime)?.activities).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Waiting for model…');
    vi.advanceTimersByTime(600);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Waiting for model… 1s');
    child.onThinking?.('先看目录结构\n再检查规则编辑器相关代码');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Thinking…');

    child.onText?.('我会先检查规则编辑器和接口定义。\n我将接着读取关键实现。');
    vi.advanceTimersByTime(399);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Thinking…');
    vi.advanceTimersByTime(1);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Preparing response…');

    child.onToolCall?.('grep_search', '{"pattern":"RuleEditor","path":"packages/rules"}', 'tool-1');
    child.onToolCall?.('read_file', '{"file_path":"packages/rules/RuleEditor.tsx"}', 'tool-2');
    child.onToolCall?.('read_file', '{"file_path":"packages/rules/index.ts"}', 'tool-3');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Preparing response…');
    vi.advanceTimersByTime(180);

    const summary = taskManager.get(taskId, runtime)?.activities?.[0]?.summary ?? '';
    expect(summary).toBe('Searching for 1 pattern, reading 2 files…');
    expect(taskManager.get(taskId, runtime)?.activities).toEqual([
      expect.objectContaining({ id: 'current-iteration' }),
    ]);
    expect(query).toHaveBeenCalledTimes(1);

    child.onToolResult?.('read_file', 'file contents', 'tool-2');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe(summary);

    const queryOptions = query.mock.calls[0]?.[1] as { onIterationComplete?: () => unknown } | undefined;
    queryOptions?.onIterationComplete?.();
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe(summary);
    vi.advanceTimersByTime(799);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe(summary);
    vi.advanceTimersByTime(1);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Waiting for model…');
    expect(query).toHaveBeenCalledTimes(1);

    child.onThinking?.('继续核对键盘事件');
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Thinking…');

    deferred.resolve('done');
    await flushAsyncWork();
  });

  it('shows only the latest heterogeneous tool and restarts aggregation after it', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const query = vi.fn(() => deferred.promise);
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'inspect files',
      prompt: 'Inspect and test the files.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    child.onToolCall?.('read_file', '{"file_path":"/workspace/src/FilesView.jsx"}', 'tool-1');
    vi.advanceTimersByTime(180);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading FilesView.jsx…');

    child.onToolCall?.('run_shell', '{"command":"rg --files build/"}', 'tool-2');
    vi.advanceTimersByTime(800);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Running rg --files build/…');

    child.onToolCall?.('read_file', '{"file_path":"src/a.ts"}', 'tool-3');
    child.onToolCall?.('read_file', '{"file_path":"src/b.ts"}', 'tool-4');
    vi.advanceTimersByTime(800);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading 2 files…');

    deferred.resolve('done');
    await flushAsyncWork();
  });

  it('flushes the final tool aggregation before entering the next model wait', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const query = vi.fn((_prompt: string, _options?: { onIterationComplete?: () => unknown }) => deferred.promise);
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'read files',
      prompt: 'Read the files.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    child.onToolCall?.('read_file', '{"file_path":"src/a.ts"}', 'tool-1');
    vi.advanceTimersByTime(180);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading a.ts…');

    child.onToolCall?.('read_file', '{"file_path":"src/b.ts"}', 'tool-2');
    const queryOptions = query.mock.calls[0]?.[1];
    queryOptions?.onIterationComplete?.();
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading 2 files…');
    vi.advanceTimersByTime(799);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading 2 files…');
    vi.advanceTimersByTime(1);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Waiting for model…');

    deferred.resolve('done');
    await flushAsyncWork();
  });

  it('drops a queued tool summary when the final activity returns to the visible summary', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const query = vi.fn((_prompt: string, _options?: { onIterationComplete?: () => unknown }) => deferred.promise);
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'inspect activity order',
      prompt: 'Inspect activity order.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    child.onToolCall?.('read_file', '{"file_path":"src/a.ts"}', 'tool-1');
    vi.advanceTimersByTime(180);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading a.ts…');

    child.onToolCall?.('run_shell', '{"command":"git status"}', 'tool-2');
    vi.advanceTimersByTime(180);
    child.onToolCall?.('read_file', '{"file_path":"src/a.ts"}', 'tool-3');
    query.mock.calls[0]?.[1]?.onIterationComplete?.();
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Reading a.ts…');
    vi.advanceTimersByTime(800);
    expect(taskManager.get(taskId, runtime)?.activities?.[0]?.summary).toBe('Waiting for model…');

    deferred.resolve('done');
    await flushAsyncWork();
  });

  it('stops model-wait timers as soon as a background task is killed', async () => {
    vi.useFakeTimers();
    const query = vi.fn(
      (_prompt: string, _options?: { onIterationComplete?: () => unknown }) => new Promise<string>(() => undefined),
    );
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'wait forever',
      prompt: 'Wait for the model.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await tool.execute({ operation: 'kill', task_id: taskId });
    expect(vi.getTimerCount()).toBe(0);

    child.onText?.('late text');
    child.onThinking?.('late thinking');
    child.onToolCall?.('read_file', '{"file_path":"late.ts"}', 'late-tool');
    query.mock.calls[0]?.[1]?.onIterationComplete?.();
    vi.advanceTimersByTime(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records the child stream into the task timeline the desktop detail modal reads', async () => {
    const deferred = createDeferred<string>();
    const query = vi.fn(() => deferred.promise);
    const { runtime, child } = createRuntimeStub(query);
    const taskManager = new SubagentTaskManager();
    const tool = new ToolAgent(runtime, taskManager);
    const started = await tool.execute({
      description: 'stream events',
      prompt: 'Stream events.',
      run_in_background: true,
      context_mode: 'none',
    });
    const taskId = started.match(/task_id: (\S+)/)?.[1] ?? '';
    await flushAsyncWork();

    child.onThinking?.('先看目录');
    child.onThinking?.('，再读文件');
    child.onText?.('开始处理');
    child.onToolCall?.('read_file', '{"file_path":"a.ts"}', 'tool-1');
    child.onToolResult?.('read_file', 'file contents', 'tool-1');
    // 嵌套 Agent 调用不进活动行，同样不进时间线。
    child.onToolCall?.('agent', '{"operation":"read"}', 'tool-2');

    expect(taskManager.get(taskId, runtime)?.timeline).toEqual([
      { id: 'thinking', kind: 'thinking', text: '先看目录，再读文件', at: expect.any(String) },
      { id: 'text', kind: 'text', text: '开始处理', at: expect.any(String) },
      {
        id: 'tool:tool-1',
        kind: 'tool',
        text: '{"file_path":"a.ts"}',
        toolName: 'read_file',
        at: expect.any(String),
      },
      {
        id: 'result:tool-1',
        kind: 'tool_result',
        text: 'file contents',
        toolName: 'read_file',
        at: expect.any(String),
      },
    ]);

    deferred.resolve('done');
    await flushAsyncWork();
    // 结束后时间线保留（弹窗要能回看已完成的 subagent），活动行则被清空。
    expect(taskManager.get(taskId, runtime)).toMatchObject({ status: 'completed', activities: [] });
    expect(taskManager.get(taskId, runtime)?.timeline).toHaveLength(4);
  });
});

function createRuntimeStub(query = vi.fn(async () => 'child result')) {
  const child: {
    query: typeof query;
    usageHistory: AgentUsageRecord[];
    onText?: (text: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: string, id?: string) => void;
    onToolResult?: (name: string, result: string, id?: string) => void;
  } = { query, usageHistory: [] as AgentUsageRecord[] };
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
  const recordSubagentUsage = vi.fn();
  const runtime = {
    createSubAgent,
    createClientOptions,
    taskOwnerId: 'owner-1',
    getSnapshot: () => ({ messages: [{ role: 'user', content: 'parent history context' }] }),
    recordSubagentUsage,
  } as unknown as AgentRuntime;
  return { runtime, child, createSubAgent, createClientOptions, query, recordSubagentUsage };
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
