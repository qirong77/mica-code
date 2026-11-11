import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mitt from 'mitt';
import { AgentAbortError } from '../agent/AgentRuntime.js';
import { HeadlessTurnExecutor, type HeadlessTurnEvent } from './HeadlessTurnExecutor.js';
import { TurnNoticeLog } from './turnNotices.js';
import { attachCodexProjector } from './CodexProjector.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import { micaSession } from '@packages/mica-session/index.js';

class MockAgent {
  readonly events = mitt();
  readonly consumers = new Set<{ text: (text: string) => void; start: () => void; rollback: () => void }>();
  registerTextRollbackConsumer(consumer: { text: (text: string) => void; start: () => void; rollback: () => void }) {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }
  runId = 0;
  aborted = false;
  getSnapshot() {
    return { providerId: 'test', model: 'test', effort: 'none', lastUsage: undefined };
  }
  runCalls: Array<{ content: unknown; options: unknown }> = [];
  iterationBoundaryResults: Array<unknown> = [];
  /** Errors to throw from run(), in order; when exhausted the run succeeds. */
  nextErrors: Array<Error> = [];
  restoreCalls = 0;
  /** 0-indexed run index after which a non-readonly toolCall is emitted. */
  emitToolCallAfterRunIndex = -1;
  /** Provider history the aborted turn was asked to record, in order. */
  abortedTurnCalls: Array<{ content: unknown; partialAnswer: string | undefined }> = [];
  /** Text streamed before the first iteration boundary (committed to history). */
  committedText = '';
  /** Text streamed after the last iteration boundary (still uncommitted). */
  uncommittedText = '';

  reserveRunId(): number {
    return ++this.runId;
  }

  get activeRunId(): number {
    return this.runId;
  }

  isCurrent(runId: number): boolean {
    return runId === this.runId && !this.aborted;
  }

  abort(): void {
    this.runId++;
    this.aborted = true;
  }

  captureClientSnapshot() {
    return { marker: 'pre-turn' };
  }

  restoreClientSnapshot() {
    this.restoreCalls++;
  }

  preserveAbortedTurn(_content: unknown, partialAnswer?: string): boolean {
    this.abortedTurnCalls.push({ content: _content, partialAnswer });
    return true;
  }

  /** Mirrors AgentRuntime.toConversationMessages(): the provider history
   *  projection the executor falls back to when no host messages are set. */
  conversationHistory: Array<{ role: string; content: unknown }> = [];
  toConversationMessages(): Array<{ role: string; content: unknown }> {
    return this.conversationHistory;
  }

  async run(
    content: unknown,
    options: { onIterationComplete?: () => unknown | Promise<unknown> } = {},
  ): Promise<{ runId: number; text: string }> {
    this.runCalls.push({ content, options });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Text streamed before an iteration boundary is committed to the provider
    // history by that boundary; whatever streams after the last one is not.
    if (this.committedText) this.events.emit('text', this.committedText);
    // Two completed tool iterations: a queued input is consumed at the first
    // boundary, and must not be injected again at the second.
    const first = options.onIterationComplete ? await options.onIterationComplete() : null;
    const second = options.onIterationComplete ? await options.onIterationComplete() : null;
    this.iterationBoundaryResults = [first, second];
    if (this.uncommittedText) this.events.emit('text', this.uncommittedText);
    if (this.aborted) throw new AgentAbortError(this.runId);
    if (this.runCalls.length - 1 === this.emitToolCallAfterRunIndex) {
      this.events.emit('toolCall', { name: 'run_shell', args: 'echo hi' });
    }
    const nextError = this.nextErrors.shift();
    if (nextError) throw nextError;
    return { runId: this.runId, text: 'done' };
  }
}

let harnessSeq = 0;

function createHarness(
  options: {
    withPluginLayer?: boolean;
    maxTurnRetries?: number;
    retryDelayMs?: number;
    applyInputSettings?: (input: RuntimeInput) => void;
  } = {},
) {
  const agent = new MockAgent();
  const events: HeadlessTurnEvent[] = [];
  const savedStates: string[] = [];
  const savedConversations: Array<Array<{ role: string }> | undefined> = [];
  const subagentSettleCalls: Array<{ reason: string; owner: unknown }> = [];
  // 每个 harness 一个独立 session id：executor 现在按轮取 turn lease，共用同一个 id
  // 会让上一个测试里还没跑完的后台 turn 把下一个测试挡成 busy-remote。
  const sessionId = `session-${++harnessSeq}`;
  const sessionController = {
    getCurrentSessionId: () => sessionId,
    acquireTurnLease: vi.fn(() => micaSession.acquireTurnLease(sessionId)),
    saveCurrent: (options: { turnState?: string; conversationMessages?: Array<{ role: string }> } = {}) => {
      savedStates.push(options.turnState ?? 'completed');
      savedConversations.push(options.conversationMessages);
      return true;
    },
    refreshFromStore: () => null,
  };
  let idleCount = 0;
  const noticeLog = new TurnNoticeLog(() => agent.toConversationMessages() as unknown as MicaUiConversationMessage[]);
  const executor = new HeadlessTurnExecutor({
    agent: agent as unknown as never,
    sessionController: sessionController as never,
    onEvent: (event) => events.push(event),
    applyInputSettings: options.applyInputSettings,
    maxTurnRetries: options.maxTurnRetries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 5,
    subagentTasks: {
      killRunningForOwner: (owner: unknown, reason: string) => {
        subagentSettleCalls.push({ owner, reason });
        return 0;
      },
    } as never,
    // 收尾发生在 turn:after 之前，所以必须有插件层才会跑（没有插件层连 agent
    // 工具都不存在，也就不会有子代理）。
    ...(options.withPluginLayer
      ? { hooks: new micaPlugin.HookRegistry(), host: { getCurrentSessionId: () => sessionId } }
      : {}),
    notices: { ensure: () => noticeLog },
    // Mirrors HeadlessPluginHost: the persisted conversation is the provider
    // history with the notices threaded back in.
    getConversationMessages: (extra?: Array<{ role: string; content: unknown }>) => {
      const messages = noticeLog.compose(extra as unknown as MicaUiConversationMessage[]);
      return messages.length > 0 ? messages : undefined;
    },
    onIdle: () => {
      idleCount++;
    },
    parseImageRefs: (text: string) => Promise.resolve(text),
  });
  return {
    agent,
    events,
    executor,
    sessionId,
    sessionController,
    noticeLog,
    savedStates,
    savedConversations,
    subagentSettleCalls,
    getIdleCount: () => idleCount,
  };
}

function input(text: string, queueMode?: 'after_iteration' | 'after_turn') {
  return {
    id: `input-${text}`,
    text,
    source: 'ui' as const,
    createdAt: Date.now(),
    ...(queueMode ? { queueMode } : {}),
  };
}

describe('HeadlessTurnExecutor', () => {
  it('registers turn preparation and idle maintenance leases with the usage recorder', async () => {
    const { SessionController } = await import('../session/SessionController.js');
    const { buildSubagentUsageRecord } = await import('@packages/mica-agent/index.js');
    const snapshot: import('../agent/AgentRuntime.js').AgentRuntimeSnapshot = {
      providerId: 'test', protocol: 'openai_responses', model: 'test-model', effort: 'none', role: 'default',
      messageFormat: 'pi-ai-v1', messages: [{ role: 'user', content: 'work', timestamp: 1 }],
      usageHistory: [], lastUsage: undefined, subagentUsageHistory: [],
    };
    const makeRecord = (taskId: string) => buildSubagentUsageRecord({
      taskId, origin: 'plugin', pluginId: 'test', subagentType: 'plugin:test', description: taskId,
      status: 'completed', startedAt: new Date().toISOString(), requests: [],
    });
    const agent = Object.assign(new MockAgent(), {
      getSnapshot: () => snapshot,
      recordSubagentUsage: (value: ReturnType<typeof makeRecord>) => { snapshot.subagentUsageHistory!.push(value); },
      loadSnapshot: vi.fn(), reloadConfig: vi.fn(),
    });
    const controller = new SessionController({
      agent: agent as unknown as import('../session/SessionController.js').SessionAgentAdapter,
      config: { apply: () => undefined }, ui: { restore: vi.fn() },
    });
    controller.saveCurrent();
    const sessionId = controller.getCurrentSessionId();
    const prepare = makeRecord('prepare');
    const maintenance = makeRecord('maintenance');
    const hooks = new micaPlugin.HookRegistry();
    hooks.on('turn:prepare', async () => {
      expect(await controller.recordSubagentUsageForSession(sessionId, prepare)).toBe(true);
    });
    let releasedBeforeAfter = false;
    hooks.on('turn:after', () => {
      const available = micaSession.acquireTurnLease(sessionId);
      releasedBeforeAfter = available !== null;
      available?.release();
    });
    let idleCount = 0;
    const executor = new HeadlessTurnExecutor({
      agent: agent as never, sessionController: controller, hooks,
      host: { getCurrentSessionId: () => sessionId }, onEvent: () => {}, onIdle: () => { idleCount++; },
      parseImageRefs: async (text) => text,
    });
    await expect(executor.start(input('work'))).resolves.toBe('started');
    await vi.waitFor(() => expect(idleCount).toBe(1));
    expect(releasedBeforeAfter).toBe(true);
    expect(controller.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([prepare]);
    await expect(executor.runIdleMaintenance(async () => {
      expect(await controller.recordSubagentUsageForSession(sessionId, maintenance)).toBe(true);
      return 'saved';
    }, 'busy')).resolves.toBe('saved');
    expect(controller.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([prepare, maintenance]);
    const available = micaSession.acquireTurnLease(sessionId);
    expect(available).not.toBeNull();
    available?.release();
  });

  it('rolls back completed responses before a turn retry and aborts the wait without saving their text', async () => {
    const { agent, executor, events } = createHarness({ retryDelayMs: 5000 });
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const projector = attachCodexProjector(
      agent as never,
      (method, params) => {
        notifications.push({ method, params: params as Record<string, unknown> });
      },
      { threadId: 'thread', turnId: 'turn', cwd: '/', textRollback: true, thinkingRollback: true, thinking: true },
    );
    let rollbackBeforeRestore = false;
    agent.events.on('thinkingTurnAttemptRollback', () => {
      rollbackBeforeRestore = agent.restoreCalls === 0;
    });
    agent.run = async (_content, options = {}) => {
      agent.events.emit('textAttemptStart');
      agent.events.emit('thinking', 'first thought');
      agent.events.emit('thinkingCheckpoint');
      agent.events.emit('text', 'first response');
      agent.events.emit('toolCall', { name: 'read_file', args: '{}', id: 'c1' });
      agent.events.emit('toolResult', { name: 'read_file', result: 'ok', id: 'c1' });
      await options.onIterationComplete?.();
      agent.events.emit('textAttemptStart');
      agent.events.emit('thinking', 'second thought');
      agent.events.emit('thinkingCheckpoint');
      agent.events.emit('text', 'second response');
      throw Object.assign(new Error('busy'), { status: 503 });
    };

    await executor.start(input('retry and abort'));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'turn:retrying' })));
    expect(rollbackBeforeRestore).toBe(true);
    expect(agent.restoreCalls).toBe(1);
    expect(
      notifications.filter(({ method }) => method === 'mica/reasoning/textRollback').map(({ params }) => params),
    ).toEqual([
      expect.objectContaining({ length: 14, micaAttemptId: 'turn:2' }),
      expect.objectContaining({ length: 13, micaAttemptId: 'turn:1' }),
    ]);
    expect(
      notifications.filter(({ method }) => method === 'mica/agentMessage/textRollback').map(({ params }) => params),
    ).toEqual([
      expect.objectContaining({ length: 15, micaAttemptId: 'turn:2' }),
      expect.objectContaining({ length: 14, micaAttemptId: 'turn:1' }),
    ]);

    executor.abort();
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn:finish', status: 'aborted' })),
    );
    expect(agent.abortedTurnCalls).toEqual([{ content: 'retry and abort', partialAnswer: undefined }]);
    projector.completeTurn('interrupted');
    expect(
      notifications.findLast(
        ({ method, params }) =>
          method === 'item/completed' && (params.item as { type: string }).type === 'agentMessage',
      )?.params.item,
    ).toMatchObject({ text: '' });
    projector.dispose();
  });

  it('registers alongside the desktop projector and preserves text before a rolled back attempt', async () => {
    const { agent, executor } = createHarness();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const projector = attachCodexProjector(agent as never, (method, params) => notifications.push({ method, params }), {
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/',
      textRollback: true,
    });
    agent.run = async () => {
      const handlers = agent.events.all.get('text') ?? [];
      expect(agent.consumers.size).toBe(2);
      expect(
        handlers.every((handler) => [...agent.consumers].some((consumer) => consumer.text === (handler as unknown))),
      ).toBe(true);
      agent.events.emit('text', 'earlier ');
      agent.events.emit('textAttemptStart');
      agent.events.emit('text', 'discarded');
      agent.events.emit('textRollback');
      agent.events.emit('textAttemptStart');
      agent.events.emit('text', 'kept');
      throw new AgentAbortError(agent.runId);
    };
    await executor.start(input('rollback'));
    await vi.waitFor(() => expect(agent.abortedTurnCalls).toHaveLength(1));
    expect(agent.abortedTurnCalls[0]?.partialAnswer).toBe('earlier kept');
    expect(notifications.some(({ method }) => method === 'mica/agentMessage/textRollback')).toBe(true);
    expect(agent.consumers.size).toBe(1);
    projector.dispose();
    expect(agent.consumers.size).toBe(0);
  });
  it('leaves the legacy projector unregistered so rollback remains disabled', async () => {
    const { agent, executor } = createHarness();
    const projector = attachCodexProjector(agent as never, () => {}, {
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/',
    });
    agent.run = async () => {
      expect(agent.events.all.get('text')).toHaveLength(2);
      expect(agent.consumers.size).toBe(1);
      return { runId: agent.runId, text: '' };
    };
    await executor.start(input('legacy'));
    await vi.waitFor(() => expect(agent.consumers.size).toBe(0));
    projector.dispose();
  });

  it('runs an idle maintenance task outside a turn and frees the lease afterwards', async () => {
    const { executor } = createHarness();
    let ran = 0;

    const result = await executor.runIdleMaintenance(async () => {
      ran++;
      return 'ok';
    }, 'busy');

    expect(result).toBe('ok');
    expect(ran).toBe(1);
    // lease 已释放：紧接着的一轮不该被自己的空闲任务挡成 busy-remote。
    await expect(executor.start(input('after idle'))).resolves.toBe('started');
  });

  it('refuses idle maintenance while a turn is running', async () => {
    const { executor } = createHarness();
    await executor.start(input('hello'));

    await expect(executor.runIdleMaintenance(async () => 'ok', 'busy')).resolves.toBe('busy');
  });

  it('makes a turn wait for an in-flight idle task instead of reporting busy-remote', async () => {
    const { agent, executor } = createHarness();
    const idle = executor.runIdleMaintenance(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'ok';
    }, 'busy');

    await expect(executor.start(input('hello'))).resolves.toBe('started');
    await expect(idle).resolves.toBe('ok');
    expect(agent.runCalls).toHaveLength(1);
  });

  it('runs the first input immediately and reports turn:start', async () => {
    const { agent, executor, events } = createHarness();
    const result = await executor.start(input('hello'));
    expect(result).toBe('started');
    expect(agent.runCalls).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn:start' });
  });

  it('saves the current provider projection instead of a stale display prefix', async () => {
    const harness = createHarness({ withPluginLayer: true });
    const previous = [{ role: 'assistant' as const, content: 'old display process' }];
    Object.assign(harness.sessionController, { getConversationMessages: () => previous });
    harness.agent.conversationHistory = [{ role: 'assistant', content: 'compacted projection' }];
    await harness.executor.start(input('new input'));
    await vi.waitFor(() => expect(harness.getIdleCount()).toBe(1));
    expect(harness.savedConversations[0]).toEqual([
      { role: 'assistant', content: 'compacted projection' },
      expect.objectContaining({ role: 'user', content: 'new input' }),
    ]);
  });

  it('awaits preparation under the lease before saving the user input', async () => {
    const steps: string[] = [];
    const harness = createHarness({ withPluginLayer: true, applyInputSettings: () => { steps.push('settings'); } });
    const hooks = (harness.executor as unknown as { options: { hooks: InstanceType<typeof micaPlugin.HookRegistry> } }).options.hooks;
    hooks.on('turn:prepare', async () => {
      const lock = join(process.env.MICA_HOME!, 'sessions', '.turn-locks', `${harness.sessionId}.lock`);
      steps.push(`prepare:${existsSync(lock)}`);
      await Promise.resolve();
      steps.push('prepared');
    });
    vi.spyOn(harness.agent, 'reserveRunId').mockImplementation(() => { steps.push('reserve'); return ++harness.agent.runId; });
    vi.spyOn(harness.sessionController, 'saveCurrent').mockImplementation(() => { steps.push('save'); return true; });
    await harness.executor.start(input('hello'));
    await vi.waitFor(() => expect(harness.getIdleCount()).toBe(1));
    expect(steps.slice(0, 5)).toEqual(['settings', 'prepare:true', 'prepared', 'reserve', 'save']);
  });

  it('applies settings to the matching input after each leased refresh and before the first save', async () => {
    const steps: string[] = [];
    const automatic = { ...input('same text'), source: 'system' as const };
    const explicit = input('same text', 'after_turn');
    const overrides = new WeakMap<RuntimeInput, string>([[explicit, 'new-model']]);
    const harness = createHarness({
      applyInputSettings: (current) => {
        const lock = join(process.env.MICA_HOME!, 'sessions', '.turn-locks', `${harness.sessionId}.lock`);
        steps.push(`apply:${current.source}:${overrides.get(current) ?? 'none'}:${existsSync(lock)}`);
        overrides.delete(current);
      },
    });
    vi.spyOn(harness.sessionController, 'refreshFromStore').mockImplementation(() => {
      steps.push('refresh');
      return null;
    });
    vi.spyOn(harness.agent, 'reserveRunId').mockImplementation(() => {
      steps.push('reserve');
      return ++harness.agent.runId;
    });
    vi.spyOn(harness.sessionController, 'saveCurrent').mockImplementation(() => {
      steps.push('save');
      return true;
    });

    await expect(harness.executor.start(automatic)).resolves.toBe('started');
    await expect(harness.executor.start(explicit)).resolves.toBe('queued');
    await vi.waitFor(() => expect(harness.getIdleCount()).toBe(1));

    expect(steps.slice(0, 4)).toEqual(['refresh', 'apply:system:none:true', 'reserve', 'save']);
    const secondRefresh = steps.indexOf('refresh', 1);
    expect(steps.slice(secondRefresh, secondRefresh + 4)).toEqual([
      'refresh',
      'apply:ui:new-model:true',
      'reserve',
      'save',
    ]);
    expect(overrides.has(explicit)).toBe(false);
  });

  it('does not apply queued settings when the input is recalled or the active turn aborts', async () => {
    const applyInputSettings = vi.fn();
    const { executor, getIdleCount } = createHarness({ applyInputSettings });
    const first = input('first');
    const recalled = input('recalled', 'after_turn');
    const pending = input('pending', 'after_turn');
    await executor.start(first);
    await expect(executor.start(recalled)).resolves.toBe('queued');
    expect(executor.recall(recalled.id)).toBe(recalled);
    await expect(executor.start(pending)).resolves.toBe('queued');
    executor.abort();
    await vi.waitFor(() => expect(getIdleCount()).toBe(1));
    expect(applyInputSettings).toHaveBeenCalledTimes(1);
    expect(applyInputSettings).toHaveBeenCalledWith(first);
    expect(executor.pendingInputs).toEqual([pending]);
  });

  it('stops the background subagents a finished turn left running', async () => {
    const harness = createHarness({ withPluginLayer: true });
    await harness.executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 一个 turn 结束后它起的后台子代理没有消费者了：结果只能经 `agent
    // operation=read` 取回，而这一轮已经交付，状态栏不该继续挂着 running。
    expect(harness.subagentSettleCalls).toHaveLength(1);
    expect(harness.subagentSettleCalls[0]).toMatchObject({ reason: 'Parent turn finished.' });
    expect(harness.subagentSettleCalls[0]?.owner).toBe(harness.agent);
  });

  it('queues an input while busy and drains it after the turn', async () => {
    const { agent, executor, events } = createHarness();
    await executor.start(input('first'));
    const result = await executor.start(input('second'));
    expect(result).toBe('queued');
    expect(events.some((event) => event.type === 'queued')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Drain loop started the second turn automatically.
    expect(agent.runCalls).toHaveLength(2);
    // The drained turn announces its own turn:start, so per-turn consumers
    // (app-server turn/started) see every turn.
    const starts = events.filter((event) => event.type === 'turn:start');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ input: expect.objectContaining({ text: 'second' }) });
  });

  it('rejects a third queued input (single-slot queue)', async () => {
    const { executor } = createHarness();
    await executor.start(input('first'));
    await executor.start(input('second'));
    const result = await executor.start(input('third'));
    expect(result).toBe('rejected');
  });

  it('injects after_iteration input at the first completed iteration boundary', async () => {
    const { agent, executor } = createHarness();
    await executor.start(input('first'));
    await executor.start(input('queued', 'after_iteration'));
    // Wait for the drain loop to run the injected content.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.iterationBoundaryResults).toEqual(['queued', null]);
    expect(agent.runCalls).toHaveLength(1);
  });

  it('persists the in-flight prompt on the turn-start save so a killed turn is recoverable', async () => {
    const { agent, executor, savedConversations } = createHarness();
    agent.conversationHistory = [{ role: 'notice', content: 'previous turn notice' }];
    await executor.start(input('hello'));

    // The first save happens before agent.run appends the prompt to the
    // provider history, so the executor records it: without it the persisted
    // session is a content-less placeholder that the session list hides, which
    // is how a session looks lost after an unexpected termination.
    expect(savedConversations[0]?.map((message) => message.role)).toEqual(['notice', 'user']);
    expect(savedConversations[0]?.at(-1)).toMatchObject({ content: 'hello' });
    // The iteration-boundary saves fall back to the provider history, which
    // already holds the prompt: appending it again would duplicate the turn.
    expect(savedConversations.slice(1).every((messages) => messages === undefined)).toBe(true);
  });

  it('does not persist plugin or system inputs as the user prompt', async () => {
    const { executor, savedConversations } = createHarness();
    await executor.start({ ...input('【系统提醒】上下文占用偏高'), source: 'system' });
    expect(savedConversations[0]).toBeUndefined();
  });

  it('keeps draining after_turn inputs until the queue is empty, then reports idle', async () => {
    const { agent, executor, getIdleCount } = createHarness();
    await executor.start(input('first'));
    await executor.start(input('second'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.runCalls).toHaveLength(2);
    expect(getIdleCount()).toBeGreaterThan(0);
  });

  it('keeps a queued input pending after an aborted turn instead of sending it', async () => {
    const { agent, executor, events } = createHarness();
    await executor.start(input('first'));
    await expect(executor.start(input('second'))).resolves.toBe('queued');

    // 用户点了停止：只有正在跑的这一轮被中止。
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 排队的那条留在队列里（仍可撤回）而不是被当成新一轮偷偷发出去——否则界面上
    // 会「先停止、再发一次、再马上停」。
    expect(agent.runCalls).toHaveLength(1);
    expect(executor.pendingInputs.map((pending) => pending.text)).toEqual(['second']);
    expect(events.filter((event) => event.type === 'turn:start')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'queue:changed',
      pending: [expect.objectContaining({ text: 'second' })],
    });
  });

  it('marks the turn aborted when the agent is aborted', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('hello'));
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finish = events.find((event) => event.type === 'turn:finish');
    expect(finish).toMatchObject({ status: 'aborted' });
  });

  it('records only the text an iteration did not already commit for an aborted turn', async () => {
    const { agent, executor } = createHarness();
    agent.committedText = 'committed half';
    agent.uncommittedText = 'tail half';
    await executor.start(input('hello'));
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(agent.abortedTurnCalls).toHaveLength(1);
    // Passing the whole streaming buffer re-appends the committed half to the
    // provider history, which is how the same assistant message is persisted twice.
    expect(agent.abortedTurnCalls[0]?.partialAnswer).toBe('tail half');
  });

  it('records no partial answer when the aborted turn had committed all of its text', async () => {
    const { agent, executor } = createHarness();
    agent.committedText = 'whole answer';
    await executor.start(input('hello'));
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(agent.abortedTurnCalls).toHaveLength(1);
    expect(agent.abortedTurnCalls[0]?.partialAnswer).toBeUndefined();
  });

  it('recalls a pending input by client message id', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('first'));
    const pending = input('pending', 'after_turn');
    await executor.start(pending);
    const removed = executor.recall(pending.id);
    expect(removed).toMatchObject({ id: pending.id, text: 'pending' });
    expect(executor.pendingInputs).toHaveLength(0);
    expect(events.some((event) => event.type === 'queue:changed')).toBe(true);
  });

  it('does not recall an input with a mismatched id', async () => {
    const { executor } = createHarness();
    await executor.start(input('first'));
    const pending = input('pending', 'after_turn');
    await executor.start(pending);
    expect(executor.recall('missing')).toBeNull();
    expect(executor.pendingInputs).toHaveLength(1);
  });

  it('reports turn:finish with the completed status and saves the session', async () => {
    const { executor, events, savedStates } = createHarness();
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finish = events.find((event) => event.type === 'turn:finish');
    expect(finish).toMatchObject({ status: 'completed' });
    expect(savedStates).toContain('running');
    expect(savedStates).toContain('completed');
  });

  it('does not copy history when turn retries are disabled', async () => {
    const { agent, executor, events } = createHarness({ maxTurnRetries: 0 });
    const capture = vi.spyOn(agent, 'captureClientSnapshot');
    await executor.start(input('no retries'));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'turn:finish' })));
    expect(capture).not.toHaveBeenCalled();
    expect(agent.runCalls).toHaveLength(1);
  });

  it('retries transient provider errors and reports turn:retrying', async () => {
    const { agent, executor, events } = createHarness();
    agent.nextErrors = [Object.assign(new Error('server is busy'), { status: 500 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.runCalls).toHaveLength(2);
    expect(agent.restoreCalls).toBe(1);
    const retrying = events.find((event) => event.type === 'turn:retrying');
    expect(retrying).toMatchObject({ type: 'turn:retrying', attempt: 1 });
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'completed' });
  });

  it('keeps unconsumed replay inputs when a retry fails before replaying them all', async () => {
    const { agent, executor, events, getIdleCount } = createHarness();
    const attemptResults: unknown[][] = [];
    const run = vi.spyOn(agent, 'run').mockImplementation(async (_content, options = {}) => {
      const results: unknown[] = [];
      attemptResults.push(results);
      if (attemptResults.length === 1) {
        for (const text of ['A', 'B']) {
          expect(await executor.start(input(text, 'after_iteration'))).toBe('queued');
          results.push(await options.onIterationComplete?.());
        }
      } else {
        results.push(await options.onIterationComplete?.());
        if (attemptResults.length === 3) {
          results.push(await options.onIterationComplete?.());
          return { runId: agent.runId, text: 'done' };
        }
      }
      throw Object.assign(new Error('server is busy'), { status: 503 });
    });

    await expect(executor.start(input('hello'))).resolves.toBe('started');
    await vi.waitFor(() => expect(getIdleCount()).toBe(1));

    expect(run).toHaveBeenCalledTimes(3);
    expect(attemptResults).toEqual([['A', 'B'], ['A'], ['A', 'B']]);
    expect(agent.restoreCalls).toBe(2);
    expect(events.filter((event) => event.type === 'turn:retrying')).toHaveLength(2);
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'completed' });
    expect(executor.pendingInputs).toEqual([]);
  });

  it('does not retry non-transient errors', async () => {
    const { agent, executor, events } = createHarness();
    agent.nextErrors = [Object.assign(new Error('bad request'), { status: 400 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.runCalls).toHaveLength(1);
    expect(events.find((event) => event.type === 'turn:retrying')).toBeUndefined();
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'error' });
  });

  it('does not retry after a non-readonly tool call ran', async () => {
    const { agent, executor, events } = createHarness();
    agent.emitToolCallAfterRunIndex = 0;
    agent.nextErrors = [Object.assign(new Error('server is busy'), { status: 500 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.runCalls).toHaveLength(1);
    expect(events.find((event) => event.type === 'turn:retrying')).toBeUndefined();
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'error' });
  });

  it('gives up after exhausting retries and reports the final error', async () => {
    const { agent, executor, events } = createHarness();
    agent.nextErrors = [
      Object.assign(new Error('busy 1'), { status: 503 }),
      Object.assign(new Error('busy 2'), { status: 503 }),
      Object.assign(new Error('busy 3'), { status: 503 }),
    ];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(agent.runCalls).toHaveLength(3); // 1 + maxTurnRetries(2)
    expect(events.filter((event) => event.type === 'turn:retrying')).toHaveLength(2);
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'error' });
  });

  it('stops retrying when the turn is aborted during the retry delay', async () => {
    const { agent, executor, events } = createHarness();
    agent.nextErrors = [Object.assign(new Error('busy'), { status: 503 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'aborted' });
  });

  it('persists a retry notice in the conversation while waiting', async () => {
    const { agent, executor, events, noticeLog, savedConversations } = createHarness();
    agent.nextErrors = [Object.assign(new Error('server is busy'), { status: 503 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.find((event) => event.type === 'turn:finish')).toMatchObject({ status: 'completed' });
    const saved = savedConversations.flatMap((messages) => messages ?? []);
    expect(saved).toContainEqual(expect.objectContaining({ role: 'notice', command: '/retry' }));
    // One slot per turn: the second attempt updates it instead of appending.
    expect(noticeLog.size).toBe(1);
  });

  it('persists the final failure as a conversation notice', async () => {
    const { agent, executor, savedConversations } = createHarness();
    agent.nextErrors = [Object.assign(new Error('bad request'), { status: 400 })];
    await executor.start(input('hello'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = savedConversations.flatMap((messages) => messages ?? []);
    expect(saved).toContainEqual(
      expect.objectContaining({ role: 'notice', command: '/error', content: '请求失败: bad request' }),
    );
  });

  it('queues with after_turn mode and reports the queue position', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('first'));
    const result = await executor.start(input('later', 'after_turn'));
    expect(result).toBe('queued');
    const queued = events.find((event) => event.type === 'queued');
    expect(queued).toMatchObject({ position: 1 });
  });
});

describe('HeadlessTurnExecutor turn lease', () => {
  function lockPath(sessionId: string) {
    return join(process.env.MICA_HOME!, 'sessions', '.turn-locks', `${sessionId}.lock`);
  }

  function writeForeignLease(sessionId: string) {
    mkdirSync(join(process.env.MICA_HOME!, 'sessions', '.turn-locks'), { recursive: true });
    // The runner's own pid is alive, so the lock is never reclaimed as orphaned.
    writeFileSync(lockPath(sessionId), JSON.stringify({ pid: process.pid, token: 'foreign' }), 'utf8');
  }

  it('refuses to run while another process holds the session lease', async () => {
    const { agent, executor, events, sessionId } = createHarness();
    writeForeignLease(sessionId);
    try {
      const result = await executor.start(input('hello'));
      expect(result).toBe('busy-remote');
      expect(agent.runCalls).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      rmSync(lockPath(sessionId), { force: true });
    }
  });

  it('holds the lease for the duration of a turn and releases it on completion', async () => {
    const { executor, sessionId } = createHarness();
    rmSync(lockPath(sessionId), { force: true });
    expect(await executor.start(input('hello'))).toBe('started');
    // The turn is still running (the mock agent yields before finishing).
    expect(existsSync(lockPath(sessionId))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(lockPath(sessionId))).toBe(false);
  });

  it('releases the lease when the turn fails', async () => {
    const { agent, executor, sessionId } = createHarness();
    rmSync(lockPath(sessionId), { force: true });
    agent.nextErrors = [new Error('boom')];
    expect(await executor.start(input('hello'))).toBe('started');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(existsSync(lockPath(sessionId))).toBe(false);
  });
});
