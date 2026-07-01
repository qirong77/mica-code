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
    setActiveContext(null);
    micaUi.conversation.clearMessages();
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.panels.clearLogEntries();
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
      logEntries: [],
      messageBarMessages: [],
      pendingInputs: [],
      pendingQueueMode: null,
      pluginUIs: [],
      responseText: '',
      thinkingText: '',
      uiLog: [],
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
