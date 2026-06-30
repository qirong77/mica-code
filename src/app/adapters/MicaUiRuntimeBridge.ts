import { calculateCachedTokenRate, type AgentUsageRecord } from '@packages/mica-agent/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { AgentRuntime, type AgentRuntimeStatus } from '../../agent/AgentRuntime.js';
import {
  normalizeUiState,
  toMicaUiWorkingStatus,
  type TerminalAgentSessionManager,
} from '../../agents/terminalAgentSessions.js';
import { ToolLogController } from '../../runtime/ToolLogController.js';
import { applyStatus, syncModelDisplay } from '../../runtime/uiBridge.js';
// import { syncStartupBanner } from '../../runtime/startupBanner.js';
import type { LocalRuntimeController } from './LocalRuntimeController.js';

const MAX_AGENT_TURN_LOG_ITEMS = 120;

export class MicaUiRuntimeBridge {
  private readonly toolLogs = new Map<AgentRuntime, ToolLogController>();
  private readonly disposers = new Map<AgentRuntime, () => void>();
  private readonly messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly preserveTurnUiOnConnecting = new Set<AgentRuntime>();

  constructor(
    private agent: AgentRuntime,
    private readonly runtime: LocalRuntimeController,
    private readonly agentSessions: TerminalAgentSessionManager,
  ) {}

  watchAgent(agent: AgentRuntime): void {
    this.attachAgentEvents(agent);
    this.syncAgentStatusItems();
  }

  switchAgent(agent: AgentRuntime): void {
    this.agent = agent;
    this.attachAgentEvents(agent);
    syncModelDisplay(agent);
    // syncStartupBanner(agent);
    this.syncAgentStatusItems();
  }

  start(): void {
    syncModelDisplay(this.agent);
    micaLogger.logRuntime('runtime', 'ui_bridge:start');

    this.attachAgentEvents(this.agent);
    this.syncAgentStatusItems();

    this.runtime.events.on('event', (event) => {
      if (event.type === 'queue:changed') {
        const owner = eventOwnerAgent(event.owner, this.agent);
        const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
        const pendingInput = event.pendingInputs.at(-1);
        const pendingInputs = pendingInput ? [pendingInput.text] : [];
        const pendingQueueMode = pendingInput?.queueMode ?? null;
        session.uiState = normalizeUiState({ ...session.uiState, pendingInputs, pendingQueueMode });
        if (this.isActiveAgent(session.agent)) micaUi.conversation.setPendingInputs(pendingInputs, pendingQueueMode);
      }
      if (event.type === 'notification') {
        const owner = eventOwnerAgent(event.owner, this.agent);
        this.showMessageForAgent(owner, event.message, event.ttl);
      }
      if (event.type === 'turn:started') {
        const owner = eventOwnerAgent(event.owner, this.agent);
        const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
        const toolLogs = this.toolLogFor(session.agent);
        const preservePreviousTurnUi = event.preservePreviousTurnUi === true;
        if (preservePreviousTurnUi) {
          this.preserveTurnUiOnConnecting.add(session.agent);
        } else {
          this.preserveTurnUiOnConnecting.delete(session.agent);
        }
        toolLogs.resetTurn({ clearThinkingText: !preservePreviousTurnUi });
        session.uiState = normalizeUiState({
          ...session.uiState,
          logEntries: preservePreviousTurnUi ? session.uiState.logEntries : [],
          agentTurnLogItems: preservePreviousTurnUi ? session.uiState.agentTurnLogItems : [],
          thinkingText: preservePreviousTurnUi ? session.uiState.thinkingText : '',
          lastTurnOutcome: 'running',
        });
        if (this.isActiveAgent(session.agent) && !preservePreviousTurnUi) {
          micaUi.panels.clearLogEntries();
          micaUi.panels.clearAgentTurnLogItems();
        }
      }
      if (event.type === 'turn:finished') {
        this.toolLogFor(eventOwnerAgent(event.owner, this.agent)).endThinkingSegment();
      }
      if (event.type === 'turn:aborted') {
        const owner = eventOwnerAgent(event.owner, this.agent);
        const session = this.agentSessions.findByAgent(owner) ?? this.agentSessions.current();
        const conversationMessages = session.uiState.conversationMessages.length
          ? session.uiState.conversationMessages
          : session.agent.toConversationMessages();
        session.uiState = normalizeUiState({
          ...session.uiState,
          conversationMessages,
          responseText: '',
          pendingInputs: [],
          pendingQueueMode: null,
          workingStatus: { type: 'idle' },
          lastTurnOutcome: 'aborted',
        });
        if (this.isActiveAgent(session.agent)) {
          micaUi.conversation.setMessages(session.uiState.conversationMessages);
          micaUi.conversation.clearResponseText();
          micaUi.conversation.clearPendingInput();
          micaUi.panels.status.idle();
        }
      }
    });

    micaUi.terminalInput.onSubmit((text, options) => {
      void this.runtime.submit(text, { queueMode: options?.queueMode });
    });

    micaUi.panels.setOnAbortAgent(() => {
      void this.runtime.abort();
    });

    micaUi.panels.setOnEditPendingInput(() => this.runtime.editLastPendingInput());
  }

  clearToolLogs(): void {
    const session = this.agentSessions.current();
    session.uiState = normalizeUiState({
      ...session.uiState,
      logEntries: [],
      agentTurnLogItems: [],
      thinkingText: '',
    });
    this.toolLogFor(this.agent).resetAll();
  }

  showMessageForAgent(agent: AgentRuntime, text: string, ttl = 3000): void {
    const session = this.sessionFor(agent);
    const id = `msg-${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.uiState = normalizeUiState({
      ...session.uiState,
      messageBarMessages: [...session.uiState.messageBarMessages, { id, text }],
    });
    if (this.isActiveAgent(agent)) {
      micaUi.messageBar.addMessage({ id, text });
    }
    const timer = setTimeout(() => {
      const currentSession = this.agentSessions.findByAgent(agent);
      if (currentSession) {
        currentSession.uiState = normalizeUiState({
          ...currentSession.uiState,
          messageBarMessages: currentSession.uiState.messageBarMessages.filter((message) => message.id !== id),
        });
      }
      if (this.isActiveAgent(agent)) micaUi.messageBar.removeMessage(id);
      this.messageTimers.delete(id);
    }, ttl);
    this.messageTimers.set(id, timer);
  }

  syncAgentStatusItems(): void {
    micaUi.panels.setAgentStatusItems(this.agentSessions.list());
  }

  stop(): void {
    for (const dispose of this.disposers.values()) dispose();
    for (const timer of this.messageTimers.values()) clearTimeout(timer);
    this.disposers.clear();
    this.toolLogs.clear();
    this.messageTimers.clear();
  }

  private onText(agent: AgentRuntime, text: string): void {
    const session = this.sessionFor(agent);
    const toolLogs = this.toolLogFor(agent);
    toolLogs.endThinkingSegment();
    const responseText = this.runtime.appendResponseTextFor(agent, text);
    session.uiState.responseText = responseText;
    if (this.isActiveAgent(agent)) micaUi.conversation.setResponseText(responseText);
  }

  private onThinking(agent: AgentRuntime, text: string): void {
    this.toolLogFor(agent).appendThinking(text);
  }

  private onToolCall(agent: AgentRuntime, toolCall: Parameters<ToolLogController['addToolCall']>[0]): void {
    this.toolLogFor(agent).addToolCall(toolCall);
  }

  private onToolResult(agent: AgentRuntime, toolResult: Parameters<ToolLogController['completeToolCall']>[0]): void {
    this.toolLogFor(agent).completeToolCall(toolResult);
  }

  private onUsage(agent: AgentRuntime, usage: AgentUsageRecord): void {
    const session = this.sessionFor(agent);
    const cachedTokenRate = calculateCachedTokenRate(agent.getSnapshot().usageHistory);
    session.uiState.contextSize = usage.totalTokens;
    session.uiState.cachedTokenRate = cachedTokenRate;
    session.uiState = normalizeUiState(session.uiState);
    if (this.isActiveAgent(agent)) {
      micaUi.panels.contextSize.set(usage.totalTokens);
      micaUi.panels.cachedTokenRate.set(cachedTokenRate);
    }
    micaLogger.logRuntime('runtime', 'usage:displayed', {
      context: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cachedTokenRate,
      paidTokenRate: usage.paidTokenRate,
    });
  }

  private attachAgentEvents(agent: AgentRuntime): void {
    if (this.disposers.has(agent)) return;
    const onStatus = (status: AgentRuntimeStatus) => this.onStatus(agent, status);
    const onText = (text: string) => this.onText(agent, text);
    const onThinking = (text: string) => this.onThinking(agent, text);
    const onToolCall = (toolCall: Parameters<ToolLogController['addToolCall']>[0]) => this.onToolCall(agent, toolCall);
    const onToolResult = (toolResult: Parameters<ToolLogController['completeToolCall']>[0]) =>
      this.onToolResult(agent, toolResult);
    const onUsage = (usage: AgentUsageRecord) => this.onUsage(agent, usage);
    agent.events.on('status', onStatus);
    agent.events.on('text', onText);
    agent.events.on('thinking', onThinking);
    agent.events.on('toolCall', onToolCall);
    agent.events.on('toolResult', onToolResult);
    agent.events.on('usage', onUsage);
    this.disposers.set(agent, () => {
      agent.events.off('status', onStatus);
      agent.events.off('text', onText);
      agent.events.off('thinking', onThinking);
      agent.events.off('toolCall', onToolCall);
      agent.events.off('toolResult', onToolResult);
      agent.events.off('usage', onUsage);
    });
  }

  private onStatus(agent: AgentRuntime, status: AgentRuntimeStatus): void {
    const session = this.sessionFor(agent);
    if (status.type === 'connecting') {
      const preservePreviousTurnUi = this.preserveTurnUiOnConnecting.has(agent);
      this.toolLogFor(agent).resetTurn({ clearThinkingText: !preservePreviousTurnUi });
      this.preserveTurnUiOnConnecting.delete(agent);
    }
    if (status.type === 'completed' || status.type === 'error' || status.type === 'idle') {
      this.toolLogFor(agent).endThinkingSegment();
    }
    session.uiState = normalizeUiState({ ...session.uiState, workingStatus: toMicaUiWorkingStatus(status) });
    this.syncAgentStatusItems();
    if (this.isActiveAgent(agent)) applyStatus(status);
  }

  private toolLogFor(agent: AgentRuntime): ToolLogController {
    let controller = this.toolLogs.get(agent);
    if (controller) return controller;
    controller = new ToolLogController({
      setThinkingText: (text) => {
        const session = this.sessionFor(agent);
        session.uiState.thinkingText = text;
        if (this.isActiveAgent(agent)) micaUi.panels.thinkingText.set(text);
      },
      appendAgentTurnLogItem: (item) => {
        const session = this.sessionFor(agent);
        session.uiState.agentTurnLogItems = [...session.uiState.agentTurnLogItems, item].slice(
          -MAX_AGENT_TURN_LOG_ITEMS,
        );
        if (this.isActiveAgent(agent)) micaUi.panels.appendAgentTurnLogItem(item);
      },
      replaceAgentTurnLogItem: (item) => {
        const session = this.sessionFor(agent);
        const items = session.uiState.agentTurnLogItems;
        const index = items.findIndex((existing) => existing.id === item.id);
        session.uiState.agentTurnLogItems = (
          index === -1 ? [...items, item] : [...items.slice(0, index), item, ...items.slice(index + 1)]
        ).slice(-MAX_AGENT_TURN_LOG_ITEMS);
        if (this.isActiveAgent(agent)) micaUi.panels.replaceAgentTurnLogItem(item);
      },
    });
    this.toolLogs.set(agent, controller);
    return controller;
  }

  private sessionFor(agent: AgentRuntime) {
    const session = this.agentSessions.findByAgent(agent);
    if (!session) throw new Error('Agent session is not registered');
    return session;
  }

  private isActiveAgent(agent: AgentRuntime): boolean {
    return this.agent === agent;
  }
}

function eventOwnerAgent(owner: unknown, fallback: AgentRuntime): AgentRuntime {
  return owner instanceof AgentRuntime ? owner : fallback;
}
