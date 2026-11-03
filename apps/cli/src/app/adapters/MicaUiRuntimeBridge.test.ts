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
    inputRoleSet: fn(),
    messageAdd: fn(),
    messageRemove: fn(),
    modelNameSet: fn(),
    modelWindowSet: fn(),
    replaceAgentTurnLogItem: fn(),
    setAgentTurnLogItems: fn(),
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
    createThinkingLogItem: (id: string, text: string) => ({ id, kind: 'thinking', text }),
    createToolCallLogItem: (item: object) => ({ ...item, kind: 'tool' }),
    bottom: { agentTurnLog: { setItems: uiMocks.setAgentTurnLogItems } },
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
      role: { set: uiMocks.inputRoleSet },
    },
  },
}));

describe('MicaUiRuntimeBridge turn UI preservation', () => {
  beforeEach(() => {
    for (const value of Object.values(uiMocks)) value.mockClear();
  });

  it('restores the response buffer and UI to the start of a failed attempt', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    let buffer = 'earlier';
    Object.assign(runtime, {
      getResponseBufferFor: () => buffer,
      setResponseBufferFor: (_agent: unknown, text: string) => { buffer = text; },
      appendResponseTextFor: (_agent: unknown, text: string) => (buffer += text),
    });
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = new Map<string, unknown>(vi.mocked(agent.events.on).mock.calls.map(([name, handler]) => [name, handler]));
    const initialLog = [...session.uiState.agentTurnLogItems];
    (handlers.get('textAttemptStart') as () => void)();
    (handlers.get('thinking') as (text: string) => void)('failed thought');
    expect(session.uiState.agentTurnLogItems).toHaveLength(initialLog.length + 1);
    (handlers.get('text') as (text: string) => void)('failed');
    expect(buffer).toBe('earlierfailed');
    (handlers.get('textRollback') as () => void)();
    expect(buffer).toBe('earlier');
    expect(session.uiState.responseText).toBe('earlier');
    expect(session.uiState.agentTurnLogItems).toEqual(initialLog);
    expect(uiMocks.thinkingSet).toHaveBeenLastCalledWith('previous thinking');
    expect(uiMocks.setAgentTurnLogItems).toHaveBeenLastCalledWith(initialLog);
    expect(uiMocks.setResponseText).toHaveBeenLastCalledWith('earlier');
    bridge.stop();
  });

  it('removes only unfinished thinking after idle has flushed several segments', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('first');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' second');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('toolCall')!({ name: 'read_file', args: '{}', id: 'call-1' });
    handlers.get('toolResult')!({ name: 'read_file', result: 'ok', id: 'call-1' });
    handlers.get('text')!('answer');
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('unfinished one');
    handlers.get('toolCall')!({ name: 'read_file', args: '{}', id: 'call-2' });
    handlers.get('toolResult')!({ name: 'read_file', result: 'ok', id: 'call-2' });
    handlers.get('text')!(' kept text');
    handlers.get('thinking')!('unfinished two');
    handlers.get('status')!({ type: 'idle' });
    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'thinking-1', text: 'first second' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
      expect.objectContaining({ id: 'thinking-2', text: 'unfinished one' }),
      expect.objectContaining({ id: 'tool-2', completed: true }),
      expect.objectContaining({ id: 'thinking-3', text: 'unfinished two' }),
    ]);

    handlers.get('thinkingRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'thinking-1', text: 'first second' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
      expect.objectContaining({ id: 'tool-2', completed: true }),
    ]);
    expect(uiMocks.setAgentTurnLogItems).toHaveBeenLastCalledWith(session.uiState.agentTurnLogItems);
    expect(runtime.getResponseBufferFor()).toBe('answer kept text');
    expect(session.uiState.responseText).toBe('answer kept text');
    runtime.events.publish({ type: 'turn:aborted', owner: agent, input: { id: 'input', text: 'test', source: 'ui', createdAt: 0 } });
    expect(session.uiState.agentTurnLogItems).toHaveLength(3);
    handlers.get('thinkingReset')!();
    expect(session.uiState.agentTurnLogItems.map((item) => item.id)).toEqual(['tool-1', 'tool-2']);
    bridge.stop();
  });

  it('restores the completed part of an active thinking row', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('thinking')!('completed');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' discarded');
    handlers.get('thinkingRollback')!();
    expect(session.uiState.thinkingText).toBe('completed');
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'thinking-1', text: 'completed' })]);
    handlers.get('status')!({ type: 'idle' });
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'thinking-1', text: 'completed' })]);
    bridge.stop();
  });

  it('undoes a failed attempt with a checkpoint, then preserves a completed retry', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('previous');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('toolCall')!({ name: 'read_file', args: '{}', id: 'call-1' });
    handlers.get('toolResult')!({ name: 'read_file', result: 'ok', id: 'call-1' });
    handlers.get('text')!('earlier');
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('failed checkpoint');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' failed tail');
    handlers.get('text')!(' failed text');
    handlers.get('textRollback')!();
    expect(runtime.getResponseBufferFor()).toBe('earlier');
    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'thinking-1', text: 'previous' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
    ]);

    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('retry completed');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' interrupted');
    handlers.get('status')!({ type: 'idle' });
    handlers.get('thinkingRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'thinking-1', text: 'previous' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
      expect.objectContaining({ id: 'thinking-3', text: 'retry completed' }),
    ]);
    expect(runtime.getResponseBufferFor()).toBe('earlier');
    bridge.stop();
  });

  it('captures buffered thinking in a retry snapshot and restores its pending state', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('thinking')!('buffered');
    handlers.get('thinking')!(' tail');
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!(' failed');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('textRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'thinking-1', text: 'buffered tail' })]);
    handlers.get('status')!({ type: 'idle' });
    handlers.get('thinkingRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([]);
    bridge.stop();
  });

  it('does not restore interrupted thinking when retry rollback follows interruption', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('thinking')!('earlier unfinished');
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!(' later unfinished');
    handlers.get('status')!({ type: 'idle' });
    handlers.get('thinkingRollback')!();
    handlers.get('textRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([]);
    expect(session.uiState.thinkingText).toBe('');
    bridge.stop();
  });

  it('keeps earlier pending thinking when only a later checkpoint was interrupted', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({ type: 'turn:started', input: micaRuntime.createRuntimeInput('test'), owner: agent });

    handlers.get('thinking')!('earlier');
    handlers.get('textAttemptStart')!();
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' unfinished');
    handlers.get('thinkingRollback')!();
    handlers.get('textRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'thinking-1', text: 'earlier' })]);
    handlers.get('status')!({ type: 'idle' });
    handlers.get('thinkingRollback')!();
    expect(session.uiState.agentTurnLogItems).toEqual([]);
    bridge.stop();
  });

  it('rolls back every response in a failed run while preserving earlier interrupted thinking', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({
      type: 'turn:started', input: micaRuntime.createRuntimeInput('continue'), owner: agent,
      preservePreviousTurnUi: true,
    });

    handlers.get('thinkingTurnAttemptStart')!();
    handlers.get('status')!({ type: 'connecting' });
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('first completed response');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('text')!('response text');
    handlers.get('toolCall')!({ name: 'read_file', args: '{}', id: 'call-1' });
    handlers.get('toolResult')!({ name: 'read_file', result: 'ok', id: 'call-1' });
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('second completed thought');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('thinking')!(' unfinished');
    handlers.get('status')!({ type: 'error', message: 'busy' });
    handlers.get('thinkingTurnAttemptRollback')!();

    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'previous-error' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
    ]);
    expect(session.uiState.thinkingText).toBe('previous thinking');

    // No new request starts if the user aborts during the delay.
    handlers.get('status')!({ type: 'idle' });
    runtime.events.publish({ type: 'turn:finished', input: micaRuntime.createRuntimeInput('continue'), owner: agent, elapsedMs: 1 });
    expect(session.uiState.thinkingText).toBe('previous thinking');
    expect(uiMocks.thinkingSet).toHaveBeenLastCalledWith('previous thinking');
    bridge.stop();
  });

  it('keeps earlier interrupted thinking through a provider request retry', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({
      type: 'turn:started', input: micaRuntime.createRuntimeInput('continue'), owner: agent,
      preservePreviousTurnUi: true,
    });
    handlers.get('thinkingTurnAttemptStart')!();
    handlers.get('status')!({ type: 'connecting' });
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('discarded');
    handlers.get('text')!('discarded text');
    handlers.get('textRollback')!();
    expect(session.uiState.thinkingText).toBe('previous thinking');
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'previous-error' })]);
    expect(runtime.getResponseBufferFor()).toBe('');
    handlers.get('status')!({ type: 'idle' });
    expect(session.uiState.thinkingText).toBe('previous thinking');
    bridge.stop();
  });

  it('restores earlier interrupted thinking when the next response is interrupted before its checkpoint', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({
      type: 'turn:started', input: micaRuntime.createRuntimeInput('continue'), owner: agent,
      preservePreviousTurnUi: true,
    });
    handlers.get('thinkingTurnAttemptStart')!();
    handlers.get('status')!({ type: 'connecting' });
    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('first unfinished segment');
    handlers.get('text')!('kept text');
    handlers.get('thinking')!('second unfinished segment');
    handlers.get('thinkingRollback')!();
    handlers.get('status')!({ type: 'idle' });
    expect(session.uiState.agentTurnLogItems).toEqual([expect.objectContaining({ id: 'previous-error' })]);
    expect(session.uiState.thinkingText).toBe('previous thinking');
    expect(runtime.getResponseBufferFor()).toBe('kept text');
    bridge.stop();
  });

  it('keeps the restored display through reconnect and interleaves new thinking with text and tools', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session));
    bridge.start();
    const handlers = agentHandlers(agent);
    runtime.events.publish({
      type: 'turn:started', input: micaRuntime.createRuntimeInput('continue'), owner: agent,
      preservePreviousTurnUi: true,
    });

    handlers.get('thinkingTurnAttemptStart')!();
    handlers.get('status')!({ type: 'connecting' });
    handlers.get('thinking')!('discarded');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('status')!({ type: 'error', message: 'busy' });
    handlers.get('thinkingTurnAttemptRollback')!();
    handlers.get('thinkingTurnAttemptStart')!();
    handlers.get('status')!({ type: 'connecting' });
    expect(session.uiState.thinkingText).toBe('previous thinking');

    handlers.get('textAttemptStart')!();
    handlers.get('thinking')!('first');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('text')!('normal text');
    handlers.get('thinking')!('second');
    handlers.get('thinkingCheckpoint')!();
    handlers.get('toolCall')!({ name: 'read_file', args: '{}', id: 'call-1' });
    handlers.get('toolResult')!({ name: 'read_file', result: 'ok', id: 'call-1' });
    handlers.get('thinking')!('unfinished');
    handlers.get('thinkingRollback')!();
    handlers.get('status')!({ type: 'idle' });
    expect(session.uiState.agentTurnLogItems).toEqual([
      expect.objectContaining({ id: 'previous-error' }),
      expect.objectContaining({ id: 'thinking-2', text: 'first' }),
      expect.objectContaining({ id: 'thinking-3', text: 'second' }),
      expect.objectContaining({ id: 'tool-1', completed: true }),
    ]);
    expect(runtime.getResponseBufferFor()).toBe('normal text');
    bridge.stop();
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

  it('syncs active and interrupted subagents owned by the current session', async () => {
    const { MicaUiRuntimeBridge } = await import('./MicaUiRuntimeBridge.js');
    const agent = createAgent();
    const otherAgent = createAgent();
    const session = createSession(agent);
    const runtime = createRuntime();
    const tasks = new SubagentTaskManager();
    const bridge = new MicaUiRuntimeBridge(agent, runtime as never, createSessionManager(session), tasks);

    bridge.start();
    const maintenance = tasks.track({
      owner: agent, description: 'internal state update', subagentType: 'plugin-maintenance',
      model: 'test-model', effort: 'none', activity: 'maintenance',
    });
    expect(uiMocks.setSubagentTaskItems).toHaveBeenLastCalledWith([]);
    maintenance.complete('done');
    expect(uiMocks.setSubagentTaskItems.mock.calls.every(([items]) => items.length === 0)).toBe(true);
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
    expect(uiMocks.setSubagentTaskItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: ownTask.id, status: 'killed' }),
    ]);
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
    expect(agent.events.off).toHaveBeenCalledWith('thinkingCheckpoint', expect.any(Function));
    expect(agent.events.off).toHaveBeenCalledWith('thinkingRollback', expect.any(Function));
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
  let responseBuffer = '';
  return {
    abort: vi.fn(),
    appendResponseTextFor: vi.fn((_agent: unknown, text: string) => (responseBuffer += text)),
    editLastPendingInput: vi.fn(),
    events: new micaRuntime.RuntimeEventBus(),
    getResponseBufferFor: vi.fn(() => responseBuffer),
    setResponseBufferFor: vi.fn((_agent: unknown, text: string) => { responseBuffer = text; }),
    submit: vi.fn(),
  };
}

function agentHandlers(agent: AgentRuntime) {
  return new Map<string, (...args: unknown[]) => void>(
    vi.mocked(agent.events.on).mock.calls.map(([name, handler]) => [name, handler as (...args: unknown[]) => void]),
  );
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
    registerTextRollbackConsumer: vi.fn(() => vi.fn()),
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
