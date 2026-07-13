import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import type { MicaUiAgentTurnLogItem } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { TerminalAgentSession } from '../../agents/terminalAgentSessions.js';
import { SubagentTaskManager } from '../../agents/SubagentTaskManager.js';

const uiMocks = (() => {
  const fn = () => vi.fn();
  return {
    appendAgentTurnLogItem: fn(),
    cachedTokenRateSet: fn(),
    clearAgentTurnLogItems: fn(),
    clearPendingInput: fn(),
    clearResponseText: fn(),
    contextSizeSet: fn(),
    effortSet: fn(),
    inputClearText: fn(),
    inputOnSubmit: fn(),
    messageAdd: fn(),
    messageRemove: fn(),
    modelNameSet: fn(),
    modelWindowSet: fn(),
    replaceAgentTurnLogItem: fn(),
    setAgentStatusItems: fn(),
    setBackgroundTaskItems: fn(),
    setSubagentTaskItems: fn(),
    setMessages: fn(),
    setOnAbortAgent: fn(),
    setOnEditPendingInput: fn(),
    setPendingInputs: fn(),
    setResponseText: fn(),
    statusCallingTool: fn(),
    statusCompleted: fn(),
    statusConnecting: fn(),
    statusError: fn(),
    statusIdle: fn(),
    statusStreaming: fn(),
    statusThinking: fn(),
    thinkingSet: fn(),
  };
})();

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    conversation: {
      clearPendingInput: uiMocks.clearPendingInput,
      clearResponseText: uiMocks.clearResponseText,
      setMessages: uiMocks.setMessages,
      setPendingInputs: uiMocks.setPendingInputs,
      setResponseText: uiMocks.setResponseText,
    },
    messageBar: {
      addMessage: uiMocks.messageAdd,
      removeMessage: uiMocks.messageRemove,
    },
    panels: {
      appendAgentTurnLogItem: uiMocks.appendAgentTurnLogItem,
      cachedTokenRate: { set: uiMocks.cachedTokenRateSet },
      clearAgentTurnLogItems: uiMocks.clearAgentTurnLogItems,
      contextSize: { set: uiMocks.contextSizeSet },
      modelDisplay: {
        contextWindowSize: { set: uiMocks.modelWindowSet },
        effort: { set: uiMocks.effortSet },
        name: { set: uiMocks.modelNameSet },
      },
      replaceAgentTurnLogItem: uiMocks.replaceAgentTurnLogItem,
      setAgentStatusItems: uiMocks.setAgentStatusItems,
      setBackgroundTaskItems: uiMocks.setBackgroundTaskItems,
      setSubagentTaskItems: uiMocks.setSubagentTaskItems,
      setOnAbortAgent: uiMocks.setOnAbortAgent,
      setOnEditPendingInput: uiMocks.setOnEditPendingInput,
      status: {
        callingTool: uiMocks.statusCallingTool,
        completed: uiMocks.statusCompleted,
        connecting: uiMocks.statusConnecting,
        error: uiMocks.statusError,
        idle: uiMocks.statusIdle,
        streaming: uiMocks.statusStreaming,
        thinking: uiMocks.statusThinking,
      },
      thinkingText: { set: uiMocks.thinkingSet },
    },
    terminalInput: {
      clearText: uiMocks.inputClearText,
      onSubmit: uiMocks.inputOnSubmit,
    },
  },
}));

describe('MicaUiRuntimeBridge turn UI preservation', () => {
  beforeEach(() => {
    for (const value of Object.values(uiMocks)) value.mockClear();
  });

  it('preserves all queue inputs from runtime events', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));

    bridge.start();
    runtime.events.publish({
      type: 'queue:changed',
      pendingInputs: [
        micaRuntime.createRuntimeInput('first queued', 'ui', { queueMode: 'after_turn' }),
        micaRuntime.createRuntimeInput('second queued full text', 'ui', {
          displayText: 'second queued display',
          queueMode: 'after_iteration',
        }),
      ],
      owner: agent,
    });

    expect(session.uiState.pendingInputs).toEqual(['first queued', 'second queued display']);
    expect(session.uiState.pendingQueueMode).toBe('after_iteration');
    expect(uiMocks.setPendingInputs).toHaveBeenCalledWith(['first queued', 'second queued display'], 'after_iteration');
  });

  it('syncs only active subagents owned by the current session', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const otherAgent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const tasks = new SubagentTaskManager();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session), tasks);

    bridge.start();
    const ownTask = tasks.start({
      owner: agent,
      description: 'inspect task UI',
      subagentType: 'Explore',
      model: 'test-model',
      effort: 'none',
      run: () => new Promise(() => undefined),
    });
    tasks.start({
      owner: otherAgent,
      description: 'other session task',
      subagentType: 'Explore',
      model: 'test-model',
      effort: 'none',
      run: () => new Promise(() => undefined),
    });

    expect(uiMocks.setSubagentTaskItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: ownTask.id, description: 'inspect task UI', status: 'running' }),
    ]);

    tasks.kill(ownTask.id, agent);
    expect(uiMocks.setSubagentTaskItems).toHaveBeenLastCalledWith([]);
    bridge.stop();
  });

  it('keeps prior turn logs when a new turn asks to preserve them', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));

    bridge.start();
    runtime.events.publish({
      type: 'turn:started',
      input: micaRuntime.createRuntimeInput('continue'),
      owner: agent,
      preservePreviousTurnUi: true,
    });

    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'previous-error' })]);
    expect(session.uiState.thinkingText).toBe('previous thinking');
    expect(session.uiState.lastTurnOutcome).toBe('running');
    expect(uiMocks.clearAgentTurnLogItems).not.toHaveBeenCalled();
    expect(uiMocks.thinkingSet).not.toHaveBeenCalledWith('');
  });

  it('clears prior logs for a normal new turn', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));

    bridge.start();
    runtime.events.publish({
      type: 'turn:started',
      input: micaRuntime.createRuntimeInput('next task'),
      owner: agent,
    });

    expect(session.uiState.agentTurnLogItems).toEqual([]);
    expect(session.uiState.thinkingText).toBe('');
    expect(session.uiState.lastTurnOutcome).toBe('running');
    expect(uiMocks.clearAgentTurnLogItems).toHaveBeenCalledTimes(1);
    expect(uiMocks.thinkingSet).toHaveBeenCalledWith('');
  });

  it('detaches agent listeners when an idle agent session is cleared', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));

    bridge.start();
    bridge.disposeAgent(agent);

    expect(agent.events.off).toHaveBeenCalledWith('status', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('text', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('thinking', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('toolCall', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('toolResult', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('usage', expect.any(Function));
  });

  it('unsubscribes bridge-level listeners on stop', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));

    bridge.start();
    bridge.stop();
    runtime.events.publish({
      type: 'queue:changed',
      pendingInputs: [micaRuntime.createRuntimeInput('after stop', 'ui')],
      owner: agent,
    });

    expect(session.uiState.pendingInputs).toEqual([]);
  });
});

function createRuntime() {
  return {
    abort: vi.fn(),
    editLastPendingInput: vi.fn(),
    events: new micaRuntime.RuntimeEventBus(),
    submit: vi.fn(),
  };
}

function createAgent(): AgentRuntime {
  return {
    config: {
      effort: 'none',
      model: 'test-model',
      provider: {
        contextWindowSize: 1000,
        id: 'test-provider',
        name: 'Test Provider',
        supportsEffort: false,
      },
    },
    events: {
      off: vi.fn(),
      on: vi.fn(),
    },
    getSnapshot: vi.fn(() => ({ usageHistory: [] })),
    toConversationMessages: vi.fn(() => []),
  } as unknown as AgentRuntime;
}

function createSession(agent: AgentRuntime): TerminalAgentSession {
  const logItem: MicaUiAgentTurnLogItem = { id: 'previous-error', component: () => null };
  return {
    agent,
    disposeStatusListener: vi.fn(),
    id: 'session-1',
    index: 1,
    sessionController: {} as TerminalAgentSession['sessionController'],
    startedAt: new Date(0).toISOString(),
    status: { type: 'error' },
    titleOverride: null,
    uiState: {
      agentTurnLogItems: [logItem],
      cachedTokenRate: 0,
      contextSize: 0,
      conversationMessages: [],
      lastTurnOutcome: 'error',
      messageBarMessages: [],
      pendingInputs: [],
      pendingQueueMode: null,
      commandPanelItems: [],
      pluginUIs: [],
      responseText: '',
      thinkingText: 'previous thinking',
      workingStatus: { type: 'error' },
    },
    updatedAt: new Date(0).toISOString(),
  };
}

function createSessionManager(session: TerminalAgentSession) {
  return {
    current: vi.fn(() => session),
    findByAgent: vi.fn((agent: AgentRuntime) => (agent === session.agent ? session : undefined)),
    list: vi.fn(() => []),
  } as never;
}
