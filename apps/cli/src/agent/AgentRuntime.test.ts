import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import type {
  AgentQueryContent,
  AgentQueryOptions,
  AgentUsageRecord,
  IAgent,
  ModelClientOptions,
} from '@packages/mica-agent/index.js';

const modelClient = createModelClientStub();

let configState: IMicaConfig | null = null;
const testConfig: IMicaConfig = {
  provider: 'test-provider',
  model: 'test-model',
  effort: 'none',
  contextWindowSize: 1000,
  providers: [
    {
      id: 'test-provider',
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions',
      models: ['test-model'],
      supportsEffort: false,
    },
  ],
};

vi.mock('@packages/mica-config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-config/index.js')>();
  return {
    ...actual,
    micaConfig: {
      ...actual.micaConfig,
      get: () => configState,
      update: (updater: (c: IMicaConfig) => IMicaConfig) => {
        if (!configState) throw new Error('config not initialized');
        configState = updater(configState);
        return configState;
      },
      resetSessionModelDefaults: () => {
        configState = { ...testConfig, providers: [...testConfig.providers] };
        return configState;
      },
      prepareSessionModelDefaults: async () => {
        configState = { ...testConfig, providers: [...testConfig.providers] };
        return configState;
      },
      assertValid: () => {},
      getModelRule: () => ({ contextSize: 1000 }),
    },
  };
});

vi.mock('@packages/mica-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-agent/index.js')>();
  return {
    ...actual,
    micaAgent: {
      ...actual.micaAgent,
      createModelClient: vi.fn(() => modelClient),
    },
  };
});

describe('AgentRuntime tool status', () => {
  beforeEach(() => {
    modelClient.resetState();
    configState = { ...testConfig, providers: [...testConfig.providers] };
  });

  it('returns to model-waiting status after a tool result is received', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const statuses: string[] = [];

    agent.events.on('status', (status) => statuses.push(status.type));
    modelClient.queryImpl = async () => {
      modelClient.onToolCall?.('run_shell', '{"command":"true"}', 'tool-1');
      modelClient.onToolResult?.('run_shell', 'done', 'tool-1');
      return 'ok';
    };

    await agent.run('hello');

    expect(statuses).toEqual(['connecting', 'calling_tool', 'connecting', 'completed']);
  });

  it('captures only provider state and keeps a retry checkpoint independent across repeated restores', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const message = { role: 'user', content: [{ type: 'text', text: 'original' }] };
    const usage: AgentUsageRecord = {
      provider: 'openai_chat_completions',
      model: 'test-model',
      turnId: 1,
      requestIndex: 1,
      messageCount: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      paidTokenRate: 1,
    };
    modelClient.messages = [message];
    modelClient.usageHistory = [usage];
    modelClient.lastUsage = usage;
    vi.mocked(modelClient.getSnapshot).mockClear();
    vi.mocked(modelClient.toConversationMessages).mockClear();

    const checkpoint = agent.captureClientSnapshot()!;
    expect(modelClient.getSnapshot).not.toHaveBeenCalled();
    expect(modelClient.toConversationMessages).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveProperty('conversationMessages');
    expect(checkpoint.lastUsage).toBe(checkpoint.usageHistory[0]);
    message.content[0]!.text = 'changed';
    modelClient.usageHistory.push({ ...usage, requestIndex: 2 });
    expect(checkpoint.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'original' }] }]);
    expect(checkpoint.usageHistory).toHaveLength(1);

    agent.restoreClientSnapshot(checkpoint);
    const restored = vi.mocked(modelClient.loadSnapshot).mock.calls.at(-1)![0];
    restored.usageHistory.push({ ...usage, requestIndex: 3 });
    (restored.messages[0] as typeof message).content[0]!.text = 'retry mutation';
    agent.restoreClientSnapshot(checkpoint);
    const next = vi.mocked(modelClient.loadSnapshot).mock.calls.at(-1)![0];
    expect(next.usageHistory).toHaveLength(1);
    expect(next.messages).toEqual(checkpoint.messages);
  });

  it('forwards provider retry info to the run onRetry callback', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const retries: Array<{ attempt: number; message: string; delayMs: number }> = [];
    modelClient.queryImpl = async (_question, options) => {
      options?.onRetry?.({
        attempt: 2,
        error: new Error('503 Our servers are currently overloaded. Please try again later.'),
        delayMs: 4000,
      });
      return 'ok';
    };

    await agent.run('hello', {
      onRetry: (info) => {
        retries.push({ attempt: info.attempt, message: (info.error as Error).message, delayMs: info.delayMs });
      },
    });

    expect(retries).toEqual([
      { attempt: 2, message: '503 Our servers are currently overloaded. Please try again later.', delayMs: 4000 },
    ]);
  });

  it('requires all thinking listeners to register rollback and resets the capability each run', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const consumer = { text: vi.fn(), thinking: vi.fn(), start: vi.fn(), rollback: vi.fn() };
    agent.events.on('text', consumer.text);
    agent.events.on('thinking', consumer.thinking);
    agent.events.on('textAttemptStart', consumer.start);
    agent.events.on('textRollback', consumer.rollback);
    agent.registerTextRollbackConsumer(consumer);
    modelClient.queryImpl = async () => {
      expect(modelClient.canRollbackThinking).toBe(true);
      return 'ok';
    };
    await agent.run('one');
    const legacy = vi.fn();
    agent.events.on('thinking', legacy);
    modelClient.queryImpl = async () => {
      expect(modelClient.canRollbackThinking).toBe(false);
      return 'ok';
    };
    await agent.run('two');
  });

  it('persists only completed Responses thinking on interrupt and clears it on model switch', async () => {
    configState = {
      ...testConfig,
      providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses', models: ['test-model', 'other-model'] }],
    };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const events: string[] = [];
    agent.events.on('thinkingCheckpoint', () => events.push('checkpoint'));
    agent.events.on('thinkingRollback', () => events.push('rollback'));
    agent.events.on('status', (status) => {
      if (status.type === 'idle') events.push('idle');
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    modelClient.queryImpl = async (_question, options) => {
      modelClient.onThinking?.('first');
      modelClient.onThinkingCheckpoint?.('part');
      modelClient.onThinking?.('\n\n'); // ResponsesClient separates parts in one response.
      modelClient.onThinking?.('second');
      modelClient.onThinkingCheckpoint?.('part');
      modelClient.onThinkingCheckpoint?.('request');
      modelClient.onThinking?.('third');
      modelClient.onThinkingCheckpoint?.('request');
      modelClient.onThinking?.('unfinished');
      ready();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
      return '';
    };
    const run = agent.run('hello');
    await started;
    expect(agent.getSnapshot().activeThinking?.text).toBe('first\n\nsecond\n\nthird');
    agent.abort();
    await expect(run).rejects.toMatchObject({ name: 'AgentAbortError' });
    expect(events).toEqual(['checkpoint', 'checkpoint', 'checkpoint', 'checkpoint', 'rollback', 'idle']);
    const snapshot = agent.getSnapshot();
    expect(snapshot.interruptedThinking).toEqual({
      providerId: 'test-provider',
      protocol: 'openai_responses',
      model: 'test-model',
      apiBase: 'https://example.com/v1',
      text: 'first\n\nsecond\n\nthird',
    });
    const restored = new AgentRuntime();
    restored.loadSnapshot(snapshot);
    expect(restored.getSnapshot().interruptedThinking?.text).toBe('first\n\nsecond\n\nthird');
    const resumedStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    modelClient.queryImpl = async (_question, options) => {
      modelClient.onThinking?.('fourth');
      modelClient.onThinkingCheckpoint?.('request');
      modelClient.onThinking?.('unfinished again');
      ready();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
      return '';
    };
    const resumedRun = restored.run('continue');
    await resumedStarted;
    restored.abort();
    await expect(resumedRun).rejects.toMatchObject({ name: 'AgentAbortError' });
    expect(restored.getSnapshot().interruptedThinking?.text).toBe('first\n\nsecond\n\nthird\n\nfourth');
    const reset = vi.fn();
    restored.events.on('thinkingReset', reset);
    restored.configureForRun({ model: 'other-model' });
    expect(restored.getSnapshot().interruptedThinking).toBeUndefined();
    expect(reset).toHaveBeenCalledTimes(1);
    restored.configureForRun({ model: 'test-model' });
    expect(restored.getSnapshot().interruptedThinking).toBeUndefined();
    restored.loadSnapshot(snapshot);
    restored.configureForRun({}, false);
    expect(restored.getSnapshot().interruptedThinking).toBeUndefined();
  });

  it('clears the active input before notifying completed listeners', async () => {
    configState = {
      ...testConfig,
      providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses' }],
    };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    let completedSnapshot: ReturnType<typeof agent.getSnapshot> | undefined;
    agent.events.on('status', (status) => {
      if (status.type === 'completed') completedSnapshot = agent.getSnapshot();
    });
    modelClient.queryImpl = async () => {
      expect(agent.getSnapshot().activeTurn).toEqual({ input: 'work', committed: false });
      expect(agent.getForkSnapshot().activeTurn).toBeUndefined();
      return 'done';
    };
    await agent.run('work');
    expect(completedSnapshot?.activeTurn).toBeUndefined();
    expect(agent.getForkSnapshot().activeTurn).toBeUndefined();
  });

  it('rolls back completed thinking from a failed provider attempt before interruption', async () => {
    configState = {
      ...testConfig,
      providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses' }],
    };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    let visible = '';
    let attemptVisible = '';
    const consumer = {
      text: vi.fn(),
      thinking: (chunk: string) => {
        visible += chunk;
      },
      start: () => {
        attemptVisible = visible;
      },
      rollback: () => {
        visible = attemptVisible;
      },
    };
    agent.events.on('text', consumer.text);
    agent.events.on('thinking', consumer.thinking);
    agent.events.on('textAttemptStart', consumer.start);
    agent.events.on('textRollback', consumer.rollback);
    agent.registerTextRollbackConsumer(consumer);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    modelClient.queryImpl = async (_question, options) => {
      modelClient.onTextAttemptStart?.();
      modelClient.onThinking?.('first');
      modelClient.onThinkingCheckpoint?.('request');
      modelClient.onTextAttemptStart?.();
      modelClient.onThinking?.('failed complete');
      modelClient.onThinkingCheckpoint?.('part');
      expect(agent.getSnapshot().activeThinking?.text).toBe('first\n\nfailed complete');
      modelClient.onTextRollback?.();
      expect(agent.getSnapshot().activeThinking?.text).toBe('first');
      expect(visible).toBe('first');
      modelClient.onTextAttemptStart?.();
      modelClient.onThinking?.('unfinished retry');
      ready();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
      return '';
    };
    const run = agent.run('hello');
    await started;
    agent.abort();
    await expect(run).rejects.toMatchObject({ name: 'AgentAbortError' });
    expect(agent.getSnapshot().interruptedThinking?.text).toBe('first');
  });

  it.each([true, false])(
    'keeps only completed Responses thinking after a terminal error (checkpoint: %s)',
    async (hasCheckpoint) => {
      configState = {
        ...testConfig,
        providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses' }],
      };
      const { AgentRuntime } = await import('./AgentRuntime.js');
      const agent = new AgentRuntime();
      let visible = '';
      let checkpoint = '';
      const events: string[] = [];
      agent.events.on('thinking', (chunk) => {
        visible += chunk;
      });
      agent.events.on('thinkingCheckpoint', () => {
        checkpoint = visible;
      });
      agent.events.on('thinkingRollback', () => {
        visible = checkpoint;
        events.push('rollback');
      });
      agent.events.on('status', (status) => {
        if (status.type === 'error') events.push('error');
      });
      modelClient.queryImpl = async () => {
        if (hasCheckpoint) {
          modelClient.onThinking?.('completed');
          modelClient.onThinkingCheckpoint?.('part');
          modelClient.onThinking?.('\n\n');
        }
        modelClient.onThinking?.('unfinished');
        throw new Error('terminal failure');
      };
      await expect(agent.run('work')).rejects.toThrow('terminal failure');
      expect(events).toEqual(['rollback', 'error']);
      expect(visible).toBe(hasCheckpoint ? 'completed' : '');
      expect(agent.getSnapshot().interruptedThinking?.text).toBe(hasCheckpoint ? 'completed' : undefined);
      expect(agent.getSnapshot().activeThinking).toBeUndefined();
    },
  );

  it('restores the original interrupted thinking when aborting during a whole-turn retry delay', async () => {
    configState = {
      ...testConfig,
      providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses' }],
    };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const original = {
      providerId: 'test-provider',
      protocol: 'openai_responses' as const,
      model: 'test-model',
      apiBase: 'https://example.com/v1',
      text: 'earlier interruption',
    };
    agent.loadSnapshot({ ...agent.getSnapshot(), interruptedThinking: original });
    agent.events.emit('thinkingTurnAttemptStart', undefined);
    modelClient.queryImpl = async () => {
      modelClient.onThinking?.('failed attempt');
      modelClient.onThinkingCheckpoint?.('request');
      throw new Error('retryable failure');
    };
    await expect(agent.run('continue')).rejects.toThrow('retryable failure');
    agent.events.emit('thinkingTurnAttemptRollback', undefined);
    agent.abort();
    expect(agent.getSnapshot().interruptedThinking).toEqual(original);
  });

  it('recovers active snapshots only for the matching Responses model and endpoint', async () => {
    configState = {
      ...testConfig,
      providers: [{ ...testConfig.providers[0]!, protocol: 'openai_responses' }],
    };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const active = {
      providerId: 'test-provider',
      protocol: 'openai_responses' as const,
      model: 'test-model',
      apiBase: 'https://example.com/v1',
      text: 'completed progress',
    };
    const snapshot = { ...agent.getSnapshot(), activeThinking: active };
    agent.loadSnapshot(snapshot);
    expect(agent.getSnapshot().interruptedThinking).toBeUndefined();
    agent.loadSnapshot(snapshot, { recoverActiveThinking: true });
    expect(agent.getSnapshot().interruptedThinking).toEqual(active);
    for (const mismatch of [
      { providerId: 'other' },
      { model: 'other' },
      { apiBase: 'https://other' },
      { protocol: 'openai_chat_completions' as const },
      { text: '' },
    ]) {
      agent.loadSnapshot({ ...snapshot, activeThinking: { ...active, ...mismatch } }, { recoverActiveThinking: true });
      expect(agent.getSnapshot().interruptedThinking).toBeUndefined();
    }
  });

  it('enables rollback only for explicitly registered text consumers', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    let text = 'earlier';
    let checkpoint = '';
    const consumer = {
      text: (chunk: string) => {
        text += chunk;
      },
      start: () => {
        checkpoint = text;
      },
      rollback: () => {
        text = checkpoint;
      },
    };
    agent.events.on('text', consumer.text);
    agent.events.on('textAttemptStart', consumer.start);
    agent.events.on('textRollback', consumer.rollback);
    const unregister = agent.registerTextRollbackConsumer(consumer);
    modelClient.queryImpl = async () => {
      modelClient.onTextAttemptStart?.();
      modelClient.onText?.('failed');
      modelClient.onTextRollback?.();
      modelClient.onTextAttemptStart?.();
      modelClient.onText?.('success');
      return 'success';
    };
    await agent.run('hello');
    expect(text).toBe('earliersuccess');

    const legacy = vi.fn();
    agent.events.on('text', legacy);
    modelClient.queryImpl = async () => {
      expect(modelClient.onTextAttemptStart).toBeUndefined();
      expect(modelClient.onTextRollback).toBeUndefined();
      return 'ok';
    };
    await agent.run('hello');
    agent.events.off('text', legacy);
    unregister();
    await agent.run('hello');
  });

  it('blocks replay if an unregistered consumer receives text during an attempt', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const consumer = { text: vi.fn(), start: vi.fn(), rollback: vi.fn() };
    agent.events.on('text', consumer.text);
    agent.events.on('textAttemptStart', consumer.start);
    agent.events.on('textRollback', consumer.rollback);
    agent.registerTextRollbackConsumer(consumer);
    const legacy = vi.fn();
    modelClient.queryImpl = async () => {
      modelClient.onTextAttemptStart?.();
      agent.events.on('text', legacy);
      modelClient.onText?.('partial');
      agent.events.off('text', legacy);
      modelClient.onTextRollback?.();
      modelClient.onText?.('replayed');
      return 'ok';
    };
    await expect(agent.run('hello')).rejects.toThrow('Text rollback consumers changed');
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(consumer.rollback).not.toHaveBeenCalled();
  });

  it('tracks each active module start time separately', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { AgentRuntime } = await import('./AgentRuntime.js');
      const agent = new AgentRuntime();
      const statuses: Array<{ type: string; moduleStartedAt?: number }> = [];

      agent.events.on('status', (status) => {
        if ('moduleStartedAt' in status) statuses.push({ type: status.type, moduleStartedAt: status.moduleStartedAt });
        else statuses.push({ type: status.type });
      });
      modelClient.queryImpl = async () => {
        vi.setSystemTime(1100);
        modelClient.onToolCall?.('read_file', '{"file_path":"a"}', 'tool-1');
        vi.setSystemTime(1300);
        modelClient.onToolResult?.('read_file', 'done', 'tool-1');
        vi.setSystemTime(1600);
        modelClient.onText?.('ok');
        vi.setSystemTime(1700);
        return 'ok';
      };

      await agent.run('hello');

      expect(statuses).toEqual([
        { type: 'connecting', moduleStartedAt: 1000 },
        { type: 'calling_tool', moduleStartedAt: 1100 },
        { type: 'connecting', moduleStartedAt: 1300 },
        { type: 'streaming', moduleStartedAt: 1600 },
        { type: 'completed' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches role without dropping the existing client snapshot', async () => {
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const createModelClient = vi.mocked(micaAgent.createModelClient);
    const reviewerClient = createModelClientStub();
    createModelClient.mockReturnValueOnce(modelClient).mockReturnValueOnce(reviewerClient);
    vi.spyOn(micaAgent.roles, 'get').mockImplementation((name: string) =>
      name === 'reviewer'
        ? { name: 'reviewer', prompt: 'Review carefully.', builtIn: false, path: '/tmp/role/reviewer' }
        : { name: 'default', prompt: 'Default prompt.', builtIn: true },
    );
    modelClient.getSnapshot = vi.fn(() => ({
      model: 'test-model',
      messages: [{ role: 'user', content: 'keep this' }],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    }));

    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setRole('reviewer');

    expect(agent.role).toBe('reviewer');
    expect(reviewerClient.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'keep this' }] }),
    );
    expect(agent.getSnapshot().role).toBe('reviewer');
    const options = createModelClient.mock.calls.at(-1)?.[0];
    expect(typeof options?.systemPrompt).toBe('function');
    expect((options?.systemPrompt as () => string)()).toContain('<system>\nReview carefully.\n</system>');
  });

  it('keeps a role name that is not resolvable yet instead of resetting it to default', async () => {
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    // 插件角色在插件 setup 之后才出现在索引里，而快照是在那之前加载的：那一刻查不到
    // 角色并不代表这个会话不是它。改写名字等于把配置删掉，下一次保存就真的落盘了。
    vi.spyOn(micaAgent.roles, 'get').mockImplementation((name: string) =>
      name === 'default' ? { name: 'default', prompt: 'Default prompt.', builtIn: true } : undefined,
    );

    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.loadSnapshot({
      providerId: 'test-provider',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: '需求开发',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    });
    expect(agent.role).toBe('需求开发');
    expect(agent.getSnapshot().role).toBe('需求开发');

    // 拼系统提示词时用默认角色那份正文（角色还没发布），但会话角色本身不变。
    expect(agent.buildSystemPrompt()).toContain('<system>');
    expect(agent.getSnapshot().role).toBe('需求开发');
  });

  it('records the system prompt actually sent into the snapshot', async () => {
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const createModelClient = vi.mocked(micaAgent.createModelClient);
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    // 还没发过请求：快照里没有提示词，界面据此说「这条会话没有记录」。
    expect(agent.getSnapshot().systemPrompt).toBeUndefined();

    const options = createModelClient.mock.calls.at(-1)?.[0];
    const sent = (options?.systemPrompt as () => string)();
    expect(sent).toContain('<context>');
    expect(agent.getSnapshot().systemPrompt).toBe(sent);

    // 恢复会话带回来的那份要留着，否则「没发新请求」时界面会以为它从没记录过。
    agent.loadSnapshot({ ...agent.getSnapshot(), systemPrompt: 'recorded earlier' });
    expect(agent.getSnapshot().systemPrompt).toBe('recorded earlier');
  });

  it('carries recorded subagent usage through snapshots and emits an event', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const emitted: unknown[] = [];
    agent.events.on('subagentUsage', (record) => emitted.push(record));

    agent.recordSubagentUsage({
      taskId: 'task-1',
      subagentType: 'Explore',
      description: 'search',
      effort: 'medium',
      status: 'completed',
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:01:00.000Z',
      requests: [
        {
          provider: 'openai_chat_completions',
          turnId: 1,
          requestIndex: 1,
          messageCount: 2,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          paidTokenRate: 1,
        },
      ],
      summary: { records: 1, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 },
    });

    expect(agent.getSnapshot().subagentUsageHistory).toHaveLength(1);
    expect(agent.getSubagentUsageHistory()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ taskId: 'task-1', status: 'completed' });

    agent.loadSnapshot(agent.getSnapshot());
    expect(agent.getSnapshot().subagentUsageHistory).toHaveLength(1);

    agent.loadSnapshot({
      providerId: 'test-provider',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    });
    expect(agent.getSnapshot().subagentUsageHistory).toEqual([]);
  });

  it('starts a fork with its own empty usage while keeping the inherited context', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const usage: AgentUsageRecord = {
      usageId: 'u1',
      provider: 'openai_chat_completions',
      turnId: 1,
      requestIndex: 1,
      messageCount: 1,
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 128,
      paidTokenRate: 1,
    };
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    vi.mocked(modelClient.getSnapshot).mockReturnValue({
      model: 'test-model',
      messages,
      usageHistory: [usage],
      lastUsage: usage,
      conversationMessages: [],
    });
    agent.recordSubagentUsage({
      taskId: 'task-1',
      subagentType: 'Explore',
      description: 'search',
      effort: 'none',
      status: 'completed',
      startedAt: '2026-08-01T00:00:00.000Z',
      requests: [usage],
      summary: { records: 1, inputTokens: 120, outputTokens: 8, cachedInputTokens: 0, totalTokens: 128 },
    });

    const fork = agent.getForkSnapshot();

    // 用量记账不继承：新会话的 Stats 从空开始，同一条请求不会在两个会话里各算一次。
    expect(fork.usageHistory).toEqual([]);
    expect(fork.subagentUsageHistory).toEqual([]);
    // 上下文与它的占用照常继承，界面 ctx 与聊天状态栏需要 lastUsage。
    expect(fork.messages).toBe(messages);
    expect(fork.lastUsage).toBe(usage);
  });

  it('applies a run-selected model without mutating global config and forwards maxTurns', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime({ model: 'run-model', effort: 'high' });
    let queryOptions: AgentQueryOptions | undefined;
    modelClient.queryImpl = async (_question, options) => {
      queryOptions = options;
      return 'ok';
    };

    await agent.run('hello', { maxTurns: 4 });
    agent.configureForRun({ effort: 'low' });

    expect(agent.config.model).toBe('run-model');
    expect(configState?.model).toBe('test-model');
    expect(queryOptions?.maxTurns).toBe(4);
  });

  it('builds the provider system prompt through wrapped plugin sections', async () => {
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const hooks = new micaPlugin.HookRegistry();

    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime({}, hooks);
    agent.promptSections.add('test', { id: 'guidance', render: () => 'Plugin system guidance.' });
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const options = vi.mocked(micaAgent.createModelClient).mock.calls.at(-1)?.[0];

    expect(agent.buildSystemPrompt()).toContain('Plugin system guidance.');
    expect(typeof options?.systemPrompt).toBe('function');
    expect((options?.systemPrompt as () => string)()).toContain('Plugin system guidance.');
  });

  it('starts new terminal sessions with defaults without changing existing agents', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const { TerminalAgentSessionManager } = await import('../agents/terminalAgentSessions.js');
    configState = { ...testConfig, model: 'previous-session-model' };
    const existing = new AgentRuntime();
    const sessions = new TerminalAgentSessionManager();
    const created = sessions.createSession();

    expect(created.model).toBe('test-model');
    expect(existing.config.model).toBe('previous-session-model');
    sessions.stop();
  });

  it.each([false, true])(
    'clears headless sessions with defaults and preserves explicit CLI overrides: %s',
    async (explicit) => {
      const { AgentRuntime } = await import('./AgentRuntime.js');
      const { createHeadlessRuntimeServices } = await import('../headless/headlessRuntimeServices.js');
      const { SessionController } = await import('../session/SessionController.js');
      testConfig.providers[0]!.supportsEffort = true;
      try {
        const agent = new AgentRuntime({ model: 'previous-session-model', effort: 'high' });
        const controller = new SessionController(agent);
        vi.spyOn(controller, 'saveCurrent').mockReturnValue(true);
        const services = createHeadlessRuntimeServices({
          agent,
          sessionController: controller,
          runtimeOverride: explicit ? { model: 'cli-model', effort: 'high' } : undefined,
          subagentTasks: {} as never,
          notices: { ensure: () => ({ clear() {}, compose: () => [] }) as never },
          isBusy: () => false,
          submit: vi.fn(),
        });
        await services.clearUI(agent as never);
        expect(agent.config.model).toBe(explicit ? 'cli-model' : 'test-model');
        expect(agent.config.effort).toBe(explicit ? 'high' : testConfig.effort);
      } finally {
        testConfig.providers[0]!.supportsEffort = false;
      }
    },
  );

  it('shares prompt sections with agents created for new terminal sessions', async () => {
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const hooks = new micaPlugin.HookRegistry();

    const { TerminalAgentSessionManager } = await import('../agents/terminalAgentSessions.js');
    const sessions = new TerminalAgentSessionManager(hooks);
    sessions.createSession();
    sessions.current().agent.promptSections.add('test', { id: 'shared', render: () => 'Shared session guidance.' });
    const next = sessions.createSession();
    expect(sessions.findById(next.id)!.agent.buildSystemPrompt()).toContain('Shared session guidance.');

    expect(sessions.current().agent.buildSystemPrompt()).toContain('Shared session guidance.');
  });
});

describe('AgentRuntime without a configured model', () => {
  beforeEach(() => {
    modelClient.resetState();
    configState = {
      ...testConfig,
      providers: [...testConfig.providers],
      model: '',
    };
  });

  it('constructs without throwing when model is empty (first-run UX)', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    expect(() => new AgentRuntime()).not.toThrow();
  });

  it('reports a clear error on run() when model is empty', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    await expect(agent.run('hello')).rejects.toThrow(/未配置模型/);
  });
});

function createModelClientStub(): IAgent<ModelClientOptions> & {
  queryImpl?: (question: AgentQueryContent, options?: AgentQueryOptions) => Promise<string>;
  resetState(): void;
} {
  return {
    model: 'test-model',
    messages: [],
    usageHistory: [],
    lastUsage: undefined,
    onText: undefined,
    onThinking: undefined,
    onToolCall: undefined,
    onToolResult: undefined,
    onUsage: undefined,
    configure: vi.fn(),
    reset: vi.fn(),
    async query(question, options) {
      return this.queryImpl?.(question, options) ?? '';
    },
    preserveAbortedTurn: vi.fn(() => false),
    toConversationMessages: vi.fn(() => []),
    getSnapshot: vi.fn(() => ({
      model: 'test-model',
      messages: [],
      usageHistory: [] as AgentUsageRecord[],
      lastUsage: undefined,
      conversationMessages: [],
    })),
    loadSnapshot: vi.fn(),
    resetState() {
      this.messages = [];
      this.usageHistory = [];
      this.lastUsage = undefined;
      this.onText = undefined;
      this.onThinking = undefined;
      this.onToolCall = undefined;
      this.onToolResult = undefined;
      this.onUsage = undefined;
      this.queryImpl = undefined;
      vi.mocked(this.configure).mockClear();
      vi.mocked(this.reset).mockClear();
      vi.mocked(this.preserveAbortedTurn).mockClear();
      vi.mocked(this.toConversationMessages).mockClear();
      vi.mocked(this.getSnapshot).mockClear();
      vi.mocked(this.loadSnapshot).mockClear();
    },
  };
}
