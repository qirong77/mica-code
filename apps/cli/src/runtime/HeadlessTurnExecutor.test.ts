import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mitt from 'mitt';
import { AgentAbortError } from '../agent/AgentRuntime.js';
import { HeadlessTurnExecutor, type HeadlessTurnEvent } from './HeadlessTurnExecutor.js';
import { TurnNoticeLog } from './turnNotices.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';

class MockAgent {
  readonly events = mitt();
  runId = 0;
  aborted = false;
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
    // Two iteration boundaries: the first starts the wait, the second proves a
    // full iteration ran (mirrors MessageQueueService.dequeueAfterCompletedIteration).
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

function createHarness(options: { withPluginLayer?: boolean } = {}) {
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
    saveCurrent: (options: { turnState?: string; conversationMessages?: Array<{ role: string }> } = {}) => {
      savedStates.push(options.turnState ?? 'completed');
      savedConversations.push(options.conversationMessages);
      return true;
    },
    refreshFromStore: () => null,
  };
  let idleCount = 0;
  const noticeLog = new TurnNoticeLog(
    () => agent.toConversationMessages() as unknown as MicaUiConversationMessage[],
  );
  const executor = new HeadlessTurnExecutor({
    agent: agent as unknown as never,
    sessionController: sessionController as never,
    onEvent: (event) => events.push(event),
    maxTurnRetries: 2,
    retryDelayMs: 5,
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
  it('runs an idle maintenance task outside a turn and frees the lease afterwards', async () => {
    const { executor } = createHarness();
    let ran = 0;

    const result = await executor.runIdleMaintenance(async () => {
      ran++;
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(ran).toBe(1);
    // lease 已释放：紧接着的一轮不该被自己的空闲任务挡成 busy-remote。
    await expect(executor.start(input('after idle'))).resolves.toBe('started');
  });

  it('refuses idle maintenance while a turn is running', async () => {
    const { executor } = createHarness();
    await executor.start(input('hello'));

    await expect(executor.runIdleMaintenance(async () => 'ok')).resolves.toBeNull();
  });

  it('makes a turn wait for an in-flight idle task instead of reporting busy-remote', async () => {
    const { agent, executor } = createHarness();
    const idle = executor.runIdleMaintenance(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'ok';
    });

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

  it('injects after_iteration input at a completed iteration boundary', async () => {
    const { agent, executor } = createHarness();
    await executor.start(input('first'));
    await executor.start(input('queued', 'after_iteration'));
    // Wait for the drain loop to run the injected content.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The injected input is returned to the provider loop at the second
    // iteration boundary (mirrors CLI after_iteration semantics).
    expect(agent.iterationBoundaryResults[1]).toBe('queued');
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
