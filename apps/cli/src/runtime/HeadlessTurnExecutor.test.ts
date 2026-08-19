import { describe, expect, it } from 'vitest';
import mitt from 'mitt';
import { AgentAbortError } from '../agent/AgentRuntime.js';
import { HeadlessTurnExecutor, type HeadlessTurnEvent } from './HeadlessTurnExecutor.js';

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

  preserveAbortedTurn(): boolean {
    return true;
  }

  async run(
    content: unknown,
    options: { onIterationComplete?: () => unknown | Promise<unknown> } = {},
  ): Promise<{ runId: number; text: string }> {
    this.runCalls.push({ content, options });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Two iteration boundaries: the first starts the wait, the second proves a
    // full iteration ran (mirrors MessageQueueService.dequeueAfterCompletedIteration).
    const first = options.onIterationComplete ? await options.onIterationComplete() : null;
    const second = options.onIterationComplete ? await options.onIterationComplete() : null;
    this.iterationBoundaryResults = [first, second];
    if (this.aborted) throw new AgentAbortError(this.runId);
    if (this.runCalls.length - 1 === this.emitToolCallAfterRunIndex) {
      this.events.emit('toolCall', { name: 'run_shell', args: 'echo hi' });
    }
    const nextError = this.nextErrors.shift();
    if (nextError) throw nextError;
    return { runId: this.runId, text: 'done' };
  }
}

function createHarness() {
  const agent = new MockAgent();
  const events: HeadlessTurnEvent[] = [];
  const savedStates: string[] = [];
  const sessionController = {
    getCurrentSessionId: () => 'session-1',
    saveCurrent: (options: { turnState?: string } = {}) => {
      savedStates.push(options.turnState ?? 'completed');
      return true;
    },
    refreshFromStore: () => null,
  };
  let idleCount = 0;
  const executor = new HeadlessTurnExecutor({
    agent: agent as unknown as never,
    sessionController: sessionController as never,
    onEvent: (event) => events.push(event),
    maxTurnRetries: 2,
    retryDelayMs: 5,
    onIdle: () => {
      idleCount++;
    },
    parseImageRefs: (text: string) => Promise.resolve(text),
  });
  return { agent, events, executor, savedStates, getIdleCount: () => idleCount };
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
  it('runs the first input immediately and reports turn:start', async () => {
    const { agent, executor, events } = createHarness();
    const result = await executor.start(input('hello'));
    expect(result).toBe('started');
    expect(agent.runCalls).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'turn:start' });
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

  it('keeps draining after_turn inputs until the queue is empty, then reports idle', async () => {
    const { agent, executor, getIdleCount } = createHarness();
    await executor.start(input('first'));
    await executor.start(input('second'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(agent.runCalls).toHaveLength(2);
    expect(getIdleCount()).toBeGreaterThan(0);
  });

  it('marks the turn aborted when the agent is aborted', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('hello'));
    executor.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finish = events.find((event) => event.type === 'turn:finish');
    expect(finish).toMatchObject({ status: 'aborted' });
  });

  it('recalls a pending input by client message id', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('first'));
    const pending = input('pending', 'after_turn');
    await executor.start(pending);
    const removed = executor.recall(pending.id);
    expect(removed).toBe(true);
    expect(executor.pendingInputs).toHaveLength(0);
    expect(events.some((event) => event.type === 'queue:changed')).toBe(true);
  });

  it('does not recall an input with a mismatched id', async () => {
    const { executor } = createHarness();
    await executor.start(input('first'));
    const pending = input('pending', 'after_turn');
    await executor.start(pending);
    expect(executor.recall('missing')).toBe(false);
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

  it('queues with after_turn mode and reports the queue position', async () => {
    const { executor, events } = createHarness();
    await executor.start(input('first'));
    const result = await executor.start(input('later', 'after_turn'));
    expect(result).toBe('queued');
    const queued = events.find((event) => event.type === 'queued');
    expect(queued).toMatchObject({ position: 1 });
  });
});
