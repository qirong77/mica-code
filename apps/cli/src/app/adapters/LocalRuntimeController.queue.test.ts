import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../../agent/AgentRuntime.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeInput, SubmitOptions } from '@packages/mica-runtime/index.js';

const previousMicaHome = process.env.MICA_HOME;
let micaHome: string;

beforeEach(() => {
  micaHome = mkdtempSync(join(tmpdir(), 'mica-runtime-queue-'));
  process.env.MICA_HOME = micaHome;
  vi.resetModules();
});

afterEach(() => {
  rmSync(micaHome, { recursive: true, force: true });
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  vi.resetModules();
});

describe('LocalRuntimeController queue drain', () => {
  it('starts the after-turn queued input as a new turn without a false lease warning', async () => {
    const { LocalRuntimeController } = await import('./LocalRuntimeController.js');
    const { SessionController } = await import('../../session/SessionController.js');
    const { micaCommands } = await import('@packages/mica-commands/index.js');
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const { default: setupMessageQueue } = await import('@packages/mica-builtin-commands/plugins/message-queue.js');

    const snapshot: AgentRuntimeSnapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    };

    let runId = 0;
    const runInputs: unknown[] = [];
    let releaseFirstRun!: (result: { runId: number; text: string }) => void;
    const firstRun = new Promise<{ runId: number; text: string }>((resolve) => {
      releaseFirstRun = resolve;
    });

    const agent = {
      events: { on: vi.fn(), off: vi.fn() },
      reserveRunId: () => ++runId,
      isCurrent: () => true,
      captureClientSnapshot: () => undefined,
      run: vi.fn((content: unknown) => {
        runInputs.push(content);
        if (runInputs.length === 1) return firstRun;
        return Promise.resolve({ runId, text: `answer for input ${runInputs.length}` });
      }),
      toConversationMessages: () => [],
      getSnapshot: () => snapshot,
      setSessionId: vi.fn(),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      preserveAbortedTurn: vi.fn(),
    } as unknown as AgentRuntime;

    const sessionController = new SessionController(agent);
    const hooks = new micaPlugin.HookRegistry();
    const services = new micaPlugin.ServiceContainer();
    const commands = new micaCommands.CommandRegistry();
    const runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services);

    const published: unknown[] = [];
    runtime.events.on('event', (event) => {
      published.push(event);
    });

    setupMessageQueue({
      pluginId: 'test.messageQueue',
      hooks,
      runtime: {
        submit: (text: string, options?: SubmitOptions) => runtime.submit(text, options),
        queue: {
          isBusy: (owner: unknown) => runtime.isAgentBusy(owner as AgentRuntime),
          enqueue: (owner: unknown, input: RuntimeInput) => runtime.enqueueForAgent(owner as AgentRuntime, input),
          dequeue: (owner: unknown) => runtime.dequeueForAgent(owner as AgentRuntime),
          list: (owner: unknown) => runtime.listQueueForAgent(owner as AgentRuntime),
        },
      },
      events: { publish: (event: unknown) => runtime.events.publish(event as never) },
      onDispose: () => {},
    } as unknown as PluginContext);

    // Turn 1 starts and blocks on the deferred provider run.
    const firstTurn = runtime.submit('first message');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // While busy, the user queues a follow-up (Enter/Tab -> after_turn).
    const queued = await runtime.submit('second message', { queueMode: 'after_turn' });
    expect(queued).toMatchObject({ ok: true, handled: true, queued: true });

    // Complete turn 1; the turn:after hook drains the queue and starts turn 2.
    releaseFirstRun({ runId: 1, text: 'first answer' });
    await firstTurn;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const leaseWarnings = published.filter(
      (event) =>
        (event as { type?: string })?.type === 'notification' &&
        String((event as { message?: unknown })?.message).includes('另一个终端或远程页面'),
    );
    expect(leaseWarnings).toEqual([]);
    expect(runInputs.map(String)).toEqual(['first message', 'second message']);
  });

  it('keeps a queued after-turn input pending after a failed turn so it can still be re-edited', async () => {
    const { LocalRuntimeController } = await import('./LocalRuntimeController.js');
    const { SessionController } = await import('../../session/SessionController.js');
    const { micaCommands } = await import('@packages/mica-commands/index.js');
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const { default: setupMessageQueue } = await import('@packages/mica-builtin-commands/plugins/message-queue.js');

    const snapshot: AgentRuntimeSnapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    };

    let runId = 0;
    const runInputs: unknown[] = [];
    let rejectFirstRun!: (error: Error) => void;
    const firstRun = new Promise<{ runId: number; text: string }>((_resolve, reject) => {
      rejectFirstRun = reject;
    });

    const agent = {
      events: { on: vi.fn(), off: vi.fn() },
      reserveRunId: () => ++runId,
      isCurrent: () => true,
      captureClientSnapshot: () => undefined,
      run: vi.fn((content: unknown) => {
        runInputs.push(content);
        if (runInputs.length === 1) return firstRun;
        return Promise.resolve({ runId, text: `answer for input ${runInputs.length}` });
      }),
      toConversationMessages: () => [],
      getSnapshot: () => snapshot,
      setSessionId: vi.fn(),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      preserveAbortedTurn: vi.fn(),
    } as unknown as AgentRuntime;

    const sessionController = new SessionController(agent);
    const hooks = new micaPlugin.HookRegistry();
    const services = new micaPlugin.ServiceContainer();
    const commands = new micaCommands.CommandRegistry();
    const runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services);

    setupMessageQueue({
      pluginId: 'test.messageQueue',
      hooks,
      runtime: {
        submit: (text: string, options?: SubmitOptions) => runtime.submit(text, options),
        queue: {
          isBusy: (owner: unknown) => runtime.isAgentBusy(owner as AgentRuntime),
          enqueue: (owner: unknown, input: RuntimeInput) => runtime.enqueueForAgent(owner as AgentRuntime, input),
          dequeue: (owner: unknown) => runtime.dequeueForAgent(owner as AgentRuntime),
          list: (owner: unknown) => runtime.listQueueForAgent(owner as AgentRuntime),
        },
      },
      events: { publish: (event: unknown) => runtime.events.publish(event as never) },
      onDispose: () => {},
    } as unknown as PluginContext);

    // Turn 1 starts and blocks on the deferred (failing) provider run.
    const firstTurn = runtime.submit('first message');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // While busy, the user queues a follow-up.
    const queued = await runtime.submit('second message', { queueMode: 'after_turn' });
    expect(queued).toMatchObject({ ok: true, handled: true, queued: true });

    // Turn 1 fails; the turn:after hook must NOT auto-submit the queued input.
    rejectFirstRun(Object.assign(new Error('provider connection lost'), { status: 400 }));
    await firstTurn;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runInputs.map(String)).toEqual(['first message']);
    expect(runtime.listQueueForAgent(agent).map((input) => input.text)).toEqual(['second message']);

    // The user can still retract it (shift + left to re-edit).
    expect(runtime.editLastPendingInput()).toBe('second message');
    expect(runtime.listQueueForAgent(agent)).toEqual([]);
  });
});
