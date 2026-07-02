import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { AgentQueryContent, AgentQueryOptions } from '@packages/mica-agent/index.js';
import { AgentAbortError, type AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import type { TerminalAgentSession } from '../../agents/terminalAgentSessions.js';
import { setActiveContext } from '../activeContext.js';
import { LocalRuntimeController } from './LocalRuntimeController.js';

describe('LocalRuntimeController abort display state', () => {
  afterEach(() => {
    vi.useRealTimers();
    setActiveContext(null);
    vi.restoreAllMocks();
    micaUi.conversation.clearMessages();
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.messageBar.clearMessages();
    micaUi.panels.clearAgentTurnLogItems();
    micaUi.panels.thinkingText.set('');
    micaUi.panels.status.idle();
  });

  it('keeps a Ctrl+C aborted turn as one display response and only preserves uncommitted text in history', async () => {
    const committedText = 'committed answer\n\n';
    const uncommittedText = 'partial answer';
    const abortDeferred = createDeferred<{ runId: number; text: string }>();
    const iterationStreamed = createDeferred<void>();
    let historyMessages: ReturnType<AgentRuntime['toConversationMessages']> = [];
    let controller: LocalRuntimeController;

    const agent = {
      abort: vi.fn(() => abortDeferred.reject(new AgentAbortError(1))),
      captureClientSnapshot: vi.fn(() => null),
      events: { off: vi.fn(), on: vi.fn() },
      getSnapshot: vi.fn(() => ({
        effort: 'none',
        lastUsage: undefined,
        messages: [],
        model: 'test-model',
        providerId: 'test-provider',
        usageHistory: [],
      })),
      preserveAbortedTurn: vi.fn((_content: AgentQueryContent, partialAnswer?: string) => {
        if (partialAnswer?.trim()) {
          historyMessages = [
            ...historyMessages,
            { role: 'assistant', content: [{ type: 'text', text: partialAnswer }] },
          ];
        }
        return true;
      }),
      restoreClientSnapshot: vi.fn(),
      run: vi.fn(async (_content: AgentQueryContent, options?: AgentQueryOptions) => {
        controller.appendResponseTextFor(agent as unknown as AgentRuntime, committedText);
        historyMessages = [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: committedText }] },
        ];
        await options?.onIterationComplete?.();
        controller.appendResponseTextFor(agent as unknown as AgentRuntime, uncommittedText);
        iterationStreamed.resolve();
        return abortDeferred.promise;
      }),
      toConversationMessages: vi.fn(() => historyMessages),
    } as unknown as AgentRuntime;

    const session = createSession(agent);
    controller = new LocalRuntimeController(
      agent,
      { saveCurrent: vi.fn() } as unknown as SessionController,
      new micaCommands.CommandRegistry(),
      new micaPlugin.HookRegistry(),
      new micaPlugin.ServiceContainer(),
    );
    setActiveContext({
      agentSessions: {
        findByAgent: vi.fn((candidate: AgentRuntime) => (candidate === agent ? session : undefined)),
      },
      uiBridge: {
        syncAgentStatusItems: vi.fn(),
      },
    });

    const submitPromise = controller.submit('hello');
    await iterationStreamed.promise;

    await expect(controller.abort()).resolves.toEqual({ ok: true });
    await expect(submitPromise).resolves.toEqual({ ok: true });

    expect(agent.preserveAbortedTurn).toHaveBeenCalledWith('hello', uncommittedText);
    expect(session.uiState.conversationMessages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: `${committedText}${uncommittedText}` },
    ]);
  });

  it('keeps full input for the agent while storing formatted display content for the UI', async () => {
    const agent = {
      abort: vi.fn(),
      captureClientSnapshot: vi.fn(() => null),
      events: { off: vi.fn(), on: vi.fn() },
      getSnapshot: vi.fn(() => ({
        effort: 'none',
        lastUsage: undefined,
        messages: [],
        model: 'test-model',
        providerId: 'test-provider',
        usageHistory: [],
      })),
      isCurrent: vi.fn(() => true),
      restoreClientSnapshot: vi.fn(),
      run: vi.fn(async () => ({ runId: 1, text: 'ok' })),
      toConversationMessages: vi.fn(() => []),
    } as unknown as AgentRuntime;
    const session = createSession(agent);
    const controller = new LocalRuntimeController(
      agent,
      { saveCurrent: vi.fn() } as unknown as SessionController,
      new micaCommands.CommandRegistry(),
      new micaPlugin.HookRegistry(),
      new micaPlugin.ServiceContainer(),
    );
    setActiveContext({
      agentSessions: {
        findByAgent: vi.fn((candidate: AgentRuntime) => (candidate === agent ? session : undefined)),
      },
      uiBridge: {
        syncAgentStatusItems: vi.fn(),
      },
    });

    await expect(
      controller.submit('full diff payload', { displayText: 'formatted git diff summary' }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(agent.run).toHaveBeenCalledWith('full diff payload', expect.any(Object));
    expect(session.uiState.conversationMessages[0]).toEqual({
      role: 'user',
      content: 'full diff payload',
      displayContent: 'formatted git diff summary',
    });
  });

  it('stores failed turn errors in the session message bar', async () => {
    const addMessage = vi.spyOn(micaUi.messageBar, 'addMessage').mockImplementation(() => undefined);
    const error = new Error('provider exploded');
    const agent = {
      abort: vi.fn(),
      captureClientSnapshot: vi.fn(() => null),
      events: { off: vi.fn(), on: vi.fn() },
      getSnapshot: vi.fn(() => ({
        effort: 'none',
        lastUsage: undefined,
        messages: [],
        model: 'test-model',
        providerId: 'test-provider',
        usageHistory: [],
      })),
      restoreClientSnapshot: vi.fn(),
      run: vi.fn(async () => {
        throw error;
      }),
      toConversationMessages: vi.fn(() => []),
    } as unknown as AgentRuntime;
    const session = createSession(agent);
    const controller = new LocalRuntimeController(
      agent,
      { saveCurrent: vi.fn() } as unknown as SessionController,
      new micaCommands.CommandRegistry(),
      new micaPlugin.HookRegistry(),
      new micaPlugin.ServiceContainer(),
    );
    setActiveContext({
      agentSessions: {
        findByAgent: vi.fn((candidate: AgentRuntime) => (candidate === agent ? session : undefined)),
      },
      uiBridge: {
        syncAgentStatusItems: vi.fn(),
      },
    });

    await expect(controller.submit('hello')).resolves.toEqual({ ok: true });

    expect(session.uiState.messageBarMessages).toEqual([
      expect.objectContaining({ text: '请求失败: provider exploded' }),
    ]);
    expect(session.uiState.lastTurnOutcome).toBe('error');
    expect(session.uiState.workingStatus).toEqual({ type: 'error' });
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '请求失败: provider exploded' }));
  });

  it('clears active lower logs after a completed turn', async () => {
    const agent = {
      abort: vi.fn(),
      captureClientSnapshot: vi.fn(() => null),
      events: { off: vi.fn(), on: vi.fn() },
      getSnapshot: vi.fn(() => ({
        effort: 'none',
        lastUsage: undefined,
        messages: [],
        model: 'test-model',
        providerId: 'test-provider',
        usageHistory: [],
      })),
      isCurrent: vi.fn(() => true),
      restoreClientSnapshot: vi.fn(),
      run: vi.fn(async () => {
        micaUi.panels.appendAgentTurnLogItem({ id: 'live-thinking', component: () => null });
        micaUi.panels.thinkingText.set('live thought');
        return { runId: 1, text: 'ok' };
      }),
      toConversationMessages: vi.fn(() => []),
    } as unknown as AgentRuntime;
    const session = createSession(agent);
    const controller = new LocalRuntimeController(
      agent,
      { saveCurrent: vi.fn() } as unknown as SessionController,
      new micaCommands.CommandRegistry(),
      new micaPlugin.HookRegistry(),
      new micaPlugin.ServiceContainer(),
    );
    setActiveContext({
      agentSessions: {
        findByAgent: vi.fn((candidate: AgentRuntime) => (candidate === agent ? session : undefined)),
      },
      uiBridge: {
        syncAgentStatusItems: vi.fn(),
      },
    });

    await expect(controller.submit('hello')).resolves.toEqual({ ok: true });

    expect(session.uiState.lastTurnOutcome).toBe('completed');
    expect(session.uiState.agentTurnLogItems).toEqual([]);
    expect(session.uiState.thinkingText).toBe('');
    expect(micaUi.panels.agentTurnLogItems.get()).toEqual([]);
    expect(micaUi.panels.thinkingText.get()).toBe('');
  });

  it('shows a retry notice while a mocked request fails with a 70% probability, then clears it after success', async () => {
    vi.useFakeTimers();
    const failureProbability = 0.7;
    const rolls = [0.69, 0.42, 0.91];
    const agent = {
      abort: vi.fn(),
      activeRunId: 1,
      captureClientSnapshot: vi.fn(() => ({ before: 'turn' })),
      events: { off: vi.fn(), on: vi.fn() },
      getSnapshot: vi.fn(() => ({
        effort: 'none',
        lastUsage: undefined,
        messages: [],
        model: 'test-model',
        providerId: 'test-provider',
        usageHistory: [],
      })),
      isCurrent: vi.fn(() => true),
      restoreClientSnapshot: vi.fn(),
      run: vi.fn(async () => {
        const roll = rolls.shift() ?? 1;
        if (roll < failureProbability) {
          throw Object.assign(new Error(`mock request failed at roll ${roll}`), { status: 503 });
        }
        return { runId: 3, text: 'eventual ok' };
      }),
      toConversationMessages: vi.fn(() => []),
    } as unknown as AgentRuntime;
    const session = createSession(agent);
    const controller = new LocalRuntimeController(
      agent,
      { saveCurrent: vi.fn() } as unknown as SessionController,
      new micaCommands.CommandRegistry(),
      new micaPlugin.HookRegistry(),
      new micaPlugin.ServiceContainer(),
    );
    setActiveContext({
      agentSessions: {
        findByAgent: vi.fn((candidate: AgentRuntime) => (candidate === agent ? session : undefined)),
      },
      uiBridge: {
        syncAgentStatusItems: vi.fn(),
      },
    });

    const submitPromise = controller.submit('hello');
    await flushAsyncWork();

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(currentRetryNotice()?.content).toContain('mock request failed at roll 0.69');
    expect(currentRetryNotice()).toEqual(expect.objectContaining({ command: '/retry', variant: 'error' }));

    await vi.advanceTimersByTimeAsync(5000);
    await flushAsyncWork();

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(currentRetryNotice()?.content).toContain('mock request failed at roll 0.42');

    await vi.advanceTimersByTimeAsync(5000);
    await expect(submitPromise).resolves.toEqual({ ok: true });

    expect(agent.run).toHaveBeenCalledTimes(3);
    expect(agent.restoreClientSnapshot).toHaveBeenCalledTimes(2);
    expect(currentRetryNotice()).toBeUndefined();
    expect(session.uiState.conversationMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
      { role: 'assistant', content: 'eventual ok' },
    ]);
  });
});

function createSession(agent: AgentRuntime): TerminalAgentSession {
  return {
    agent,
    disposeStatusListener: vi.fn(),
    id: 'session-1',
    index: 1,
    sessionController: {} as TerminalAgentSession['sessionController'],
    startedAt: new Date(0).toISOString(),
    status: { type: 'idle' },
    titleOverride: null,
    uiState: {
      agentTurnLogItems: [],
      cachedTokenRate: 0,
      contextSize: 0,
      conversationMessages: [],
      lastTurnOutcome: 'idle',
      messageBarMessages: [],
      pendingInputs: [],
      pendingQueueMode: null,
      pluginUIs: [],
      responseText: '',
      thinkingText: '',
      workingStatus: { type: 'idle' },
    },
    updatedAt: new Date(0).toISOString(),
  };
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
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function currentRetryNotice() {
  return micaUi.conversation.messages
    .get()
    .find((message) => message.role === 'notice' && message.command === '/retry');
}
