import { afterEach, describe, expect, it, vi } from 'vitest';
import mitt from 'mitt';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { AgentRuntime, type AgentRuntimeEvents } from '../../agent/AgentRuntime.js';
import type { TerminalAgentSession, TerminalAgentSessionManager } from '../../agents/terminalAgentSessions.js';
import type { SessionController } from '../../session/SessionController.js';
import { setActiveContext } from '../activeContext.js';
import { LocalRuntimeController } from './LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './MicaUiRuntimeBridge.js';

vi.mock('../../runtime/RewindCheckpointManager.js', () => ({
  RewindCheckpointManager: class {
    capture() { return 'checkpoint'; }
    finalize() {}
  },
}));

describe('LocalRuntimeController retry display', () => {
  afterEach(() => setActiveContext(null));

  it.each([true, false])('restores earlier interrupted display before aborting a retry delay (active=%s)', async (active) => {
    const events = mitt<AgentRuntimeEvents>();
    let runId = 0;
    const agent = {
      events,
      config: { model: 'test', effort: 'none', provider: { supportsEffort: false, contextWindowSize: 1000 } },
      role: 'test',
      reserveRunId: () => ++runId,
      isCurrent: (id: number) => id === runId,
      abort: () => { runId++; events.emit('status', { type: 'idle' }); },
      captureClientSnapshot: () => ({ messages: [] }),
      restoreClientSnapshot: vi.fn(),
      preserveAbortedTurn: vi.fn(),
      registerTextRollbackConsumer: () => () => {},
      toConversationMessages: () => [],
      getSnapshot: () => ({ usageHistory: [] }),
      run: async (_question: unknown, options: { onIterationComplete(): Promise<unknown> }) => {
        events.emit('status', { type: 'connecting' });
        events.emit('textAttemptStart', undefined);
        events.emit('thinking', 'completed response thought');
        events.emit('thinkingCheckpoint', undefined);
        events.emit('text', 'completed response text');
        events.emit('toolCall', { name: 'read_file', args: '{}', id: 'call-1' });
        events.emit('toolResult', { name: 'read_file', result: 'ok', id: 'call-1' });
        await options.onIterationComplete();
        events.emit('textAttemptStart', undefined);
        events.emit('thinking', 'another completed thought');
        events.emit('thinkingCheckpoint', undefined);
        events.emit('status', { type: 'error', message: 'busy' });
        throw Object.assign(new Error('busy'), { status: 503 });
      },
    } as unknown as AgentRuntime;
    Object.setPrototypeOf(agent, AgentRuntime.prototype);
    const saves: Array<{ turnState?: string; thinking: string; ids: string[] }> = [];
    const sessionController = {
      getCurrentSessionId: () => 'local-retry-test',
      acquireTurnLease: vi.fn(() => ({ sessionId: 'local-retry-test', isHeld: () => true, release: vi.fn() })),
      refreshFromStore: () => null,
      saveCurrent: (options: { turnState?: string }) => {
        saves.push({
          turnState: options.turnState,
          thinking: session.uiState.thinkingText,
          ids: session.uiState.agentTurnLogItems.map((item) => item.id),
        });
        return true;
      },
    } as unknown as SessionController;
    const session = {
      id: 'local-retry-test', agent, sessionController,
      uiState: {
        conversationMessages: [], responseText: '', pendingInputs: [], pendingQueueMode: null,
        messageBarMessages: [], agentTurnLogItems: [micaUi.createThinkingLogItem('restored-thinking', 'earlier interrupted')],
        commandPanelItems: [], thinkingText: 'earlier interrupted', pluginUIs: [],
        workingStatus: { type: 'idle' }, lastTurnOutcome: 'aborted', contextSize: 0, cachedTokenRate: 0,
      },
    } as unknown as TerminalAgentSession;
    const primaryAgent = active ? agent : { ...agent, events: mitt<AgentRuntimeEvents>() } as AgentRuntime;
    Object.setPrototypeOf(primaryAgent, AgentRuntime.prototype);
    const primarySession = active ? session : { ...session, agent: primaryAgent };
    const sessions = {
      current: () => primarySession,
      findByAgent: (candidate: AgentRuntime) => candidate === agent ? session : candidate === primaryAgent ? primarySession : undefined,
      list: () => [],
    } as unknown as TerminalAgentSessionManager;
    const runtime = new LocalRuntimeController(primaryAgent, sessionController, { resolve: () => null } as never, new micaPlugin.HookRegistry(), {} as never);
    const bridge = new MicaUiRuntimeBridge(primaryAgent, runtime, sessions);
    setActiveContext({ agentSessions: sessions, uiBridge: bridge });
    bridge.start();
    if (!active) bridge.watchAgent(agent);
    try {
      const submission = active
        ? runtime.submit('continue')
        : runtime.submitToAgent(agent, sessionController, 'continue');
      await vi.waitFor(() => expect(agent.restoreClientSnapshot).toHaveBeenCalledOnce());
      expect(session.uiState.thinkingText).toBe('earlier interrupted');
      expect(session.uiState.agentTurnLogItems.map((item) => item.id)).toEqual(['restored-thinking', 'tool-1']);
      expect(runtime.getResponseBufferFor(agent)).toBe('');
      expect(saves.at(-1)).toMatchObject({ turnState: 'running', thinking: 'earlier interrupted', ids: ['restored-thinking', 'tool-1'] });

      if (active) await runtime.abort();
      else agent.abort();
      await submission;
      expect(agent.preserveAbortedTurn).toHaveBeenCalledWith('continue', '');
      expect(session.uiState.lastTurnOutcome).toBe('aborted');
      expect(session.uiState.thinkingText).toBe('earlier interrupted');
      expect(saves.at(-1)).toMatchObject({ turnState: 'aborted', thinking: 'earlier interrupted', ids: ['restored-thinking', 'tool-1'] });
    } finally {
      bridge.stop();
      await runtime.stop();
    }
  });
});
