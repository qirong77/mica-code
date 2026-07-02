import { calculateCachedTokenRate } from '@packages/mica-agent/index.js';
import { micaBuiltinCommands, type CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi, type MicaUiConversationMessage, type MicaUiWorkingStatus } from '@packages/mica-ui/index.js';
import { normalizeUiState, type TerminalAgentUiState } from '../../agents/terminalAgentSessions.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';
import type { SessionController } from '../../session/SessionController.js';
import { clearUI, showMessage as showGlobalMessage, syncModelDisplay } from '../../runtime/uiBridge.js';
import { resolveCommandAgent } from './activeCommandProxies.js';

function currentContext(): ApplicationContext | null {
  return getActiveContext<ApplicationContext>();
}

function captureSessionUi(): TerminalAgentUiState {
  return {
    conversationMessages: micaUi.conversation.messages.get(),
    responseText: micaUi.conversation.responseText.get(),
    pendingInputs: micaUi.conversation.pendingInputs.get(),
    pendingQueueMode: micaUi.conversation.pendingQueueMode.get(),
    messageBarMessages: micaUi.messageBar.getMessages(),
    logEntries: micaUi.panels.logEntries.get(),
    agentTurnLogItems: micaUi.panels.agentTurnLogItems.get(),
    uiLog: micaUi.panels.uiLog.get(),
    thinkingText: micaUi.panels.thinkingText.get(),
    pluginUIs: micaUi.panels.pluginUIs.get(),
    workingStatus: micaUi.panels.workingStatus.get(),
    lastTurnOutcome: currentContext()?.agentSessions.current().uiState.lastTurnOutcome ?? 'idle',
    contextSize: micaUi.panels.contextSize.get(),
    cachedTokenRate: micaUi.panels.cachedTokenRate.get(),
  };
}

function setAgentWorkingStatus(
  context: ApplicationContext,
  agent: AgentRuntime,
  status: MicaUiWorkingStatus,
  ownerSessionId?: string,
): void {
  const session = ownerSessionId
    ? context.agentSessions.findById(ownerSessionId)
    : context.agentSessions.findByAgent(agent);
  const targetSession = session ?? context.agentSessions.current();
  const targetAgent = session?.agent ?? agent;
  context.agentSessions.setStatusForAgent(targetAgent, status);
  targetSession.uiState = normalizeUiState({ ...targetSession.uiState, workingStatus: status });
  if (context.agentSessions.current().id === targetSession.id) {
    micaUi.panels.setWorkingStatus(status);
  }
  context.uiBridge.syncAgentStatusItems();
}

function restoreSessionUi(agent: AgentRuntime, uiState: TerminalAgentUiState): void {
  const snapshot = agent.getSnapshot();
  micaUi.conversation.setMessages(
    uiState.conversationMessages.length > 0 ? uiState.conversationMessages : agent.toConversationMessages(),
  );
  micaUi.conversation.setResponseText(uiState.responseText);
  micaUi.conversation.setPendingInputs(uiState.pendingInputs, uiState.pendingQueueMode);
  micaUi.panels.thinkingText.set(uiState.thinkingText);
  micaUi.panels.setLogEntries(uiState.logEntries);
  micaUi.panels.setAgentTurnLogItems(uiState.agentTurnLogItems);
  micaUi.panels.uiLog.set(uiState.uiLog);
  micaUi.panels.setPluginUIs(uiState.pluginUIs);
  micaUi.messageBar.setMessages(uiState.messageBarMessages);
  micaUi.panels.setWorkingStatus(uiState.workingStatus);
  micaUi.terminalInput.clearText();
  if (uiState.contextSize > 0 || uiState.cachedTokenRate > 0) {
    micaUi.panels.contextSize.set(uiState.contextSize);
    micaUi.panels.cachedTokenRate.set(uiState.cachedTokenRate);
  } else if (snapshot.lastUsage) {
    micaUi.panels.contextSize.set(snapshot.lastUsage.totalTokens);
    micaUi.panels.cachedTokenRate.set(calculateCachedTokenRate(snapshot.usageHistory));
  } else {
    micaUi.panels.contextSize.set(0);
    micaUi.panels.cachedTokenRate.set(0);
  }
}

function showNoticeForSession(
  context: ApplicationContext | null,
  ownerSessionId: string | undefined,
  text: string,
  options: { variant?: 'recap' | 'commit' | 'compact'; command?: string } = {},
): void {
  const session = ownerSessionId ? context?.agentSessions.findById(ownerSessionId) : context?.agentSessions.current();
  const message = { role: 'notice' as const, content: text, ...options };
  if (!context || !session) {
    micaUi.conversation.appendNoticeMessage(text, options);
    return;
  }
  const nextMessages = [...session.uiState.conversationMessages, message];
  session.uiState = normalizeUiState({ ...session.uiState, conversationMessages: nextMessages });
  if (context.agentSessions.current().id === session.id) {
    micaUi.conversation.setMessages(session.uiState.conversationMessages);
  }
  session.sessionController.saveCurrent({ allowEmpty: true });
}

function showRecapForSession(
  context: ApplicationContext | null,
  ownerSessionId: string | undefined,
  text: string,
  command: string,
): void {
  showNoticeForSession(context, ownerSessionId, text, { variant: 'recap', command });
}

function formatRecapCommand(options?: { customInstructions?: string }): string {
  const focus = options?.customInstructions?.trim();
  return focus ? `/recap ${focus}` : '/recap';
}

function showCommitNoticeForSession(
  context: ApplicationContext | null,
  ownerSessionId: string | undefined,
  text: string,
): void {
  showNoticeForSession(context, ownerSessionId, text, { variant: 'commit', command: '/commit' });
}

function hideCompactArtifacts(messages: MicaUiConversationMessage[]): MicaUiConversationMessage[] {
  return messages.filter((message) => {
    const text = conversationContentToText(message.content);
    return !text.startsWith(micaContext.COMPACT_BOUNDARY_PREFIX) && !text.startsWith(micaContext.COMPACT_SUMMARY_PREFIX);
  });
}

function conversationContentToText(content: MicaUiConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function buildRecapPrompt(customInstructions?: string): string {
  return [
    'You are creating a recap for a coding-agent terminal UI.',
    'Use only the transcript provided by the user. Do not call tools.',
    'This recap must not include new facts.',
    '',
    'Write in Chinese unless the transcript is mostly English.',
    'Return exactly one paragraph of no more than 4 sentences.',
    'Cover only: what the user is building/what the current task is, the most recent meaningful progress or result, and the immediate next step.',
    'Do not list files, commands, or details. Synthesize, do not enumerate.',
    'Return plain markdown text only. Do not wrap in XML tags, code fences, bullet lists, or headings.',
    customInstructions?.trim() ? `\nAdditional user focus:\n${customInstructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRecapTranscript(messages: unknown[]): string {
  if (messages.length === 0) return '(empty conversation)';
  return messages
    .map((message, index) => `## Message ${index + 1}\n${truncateMiddle(stringifyValue(message), 12_000)}`)
    .join('\n\n');
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[recap transcript truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.55);
  const tail = Math.floor(budget * 0.45);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function cleanRecapSummary(text: string): string {
  return text
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export function createCommandRuntimeServices(): CommandRuntimeServices {
  return {
    clearUI(agent, sessionController) {
      const context = currentContext();
      const session = context?.agentSessions.current();
      context?.runtime.clear();
      context?.uiBridge.clearToolLogs();
      clearUI(
        session?.agent ?? (agent as AgentRuntime),
        session?.sessionController ?? (sessionController as SessionController | undefined),
      );
      if (session) {
        session.titleOverride = session.sessionController.getCurrentTitle();
        session.uiState = normalizeUiState({ ...captureSessionUi(), lastTurnOutcome: 'idle' });
        context?.uiBridge.syncAgentStatusItems();
      }
    },
    showMessage(text, ttl, ownerSessionId) {
      const context = currentContext();
      const session = ownerSessionId
        ? context?.agentSessions.findById(ownerSessionId)
        : context?.agentSessions.current();
      if (context && session) {
        context.uiBridge.showMessageForAgent(session.agent, text, ttl);
        return;
      }
      showGlobalMessage(text, ttl);
    },
    showNotice(text, ownerSessionId, options) {
      showNoticeForSession(currentContext(), ownerSessionId, text, options);
    },
    showCommitNotice(text, ownerSessionId) {
      showCommitNoticeForSession(currentContext(), ownerSessionId, text);
    },
    setPluginStatus(agent, text, options = {}) {
      const context = currentContext();
      if (!context) return;
      const target = resolveCommandAgent(agent);
      const status: MicaUiWorkingStatus = { type: 'plugin_task', text, level: options.level };
      setAgentWorkingStatus(context, target, status, options.ownerSessionId);
    },
    clearPluginStatus(agent, ownerSessionId) {
      const context = currentContext();
      if (!context) return;
      setAgentWorkingStatus(context, resolveCommandAgent(agent), { type: 'idle' }, ownerSessionId);
    },
    syncModelDisplay(_agent) {
      const session = currentContext()?.agentSessions.current();
      const target = _agent as AgentRuntime;
      if (session && target instanceof AgentRuntime && session.agent !== target) return;
      syncModelDisplay(session?.agent ?? target);
    },
    isAgentRunning() {
      return currentContext()?.runtime.getStatus().running ?? false;
    },
    isAgentBusy(agent) {
      const context = currentContext();
      if (!context) return false;
      const target = agent ? resolveCommandAgent(agent) : context.agentSessions.current().agent;
      return context.runtime.isAgentBusy(target);
    },
    getCurrentAgentSessionId() {
      return currentContext()?.agentSessions.current().id;
    },
    getCurrentAgent() {
      return currentContext()?.agentSessions.current().agent;
    },
    getCurrentSessionController() {
      return currentContext()?.agentSessions.current().sessionController;
    },
    renameCurrentAgentSession(title) {
      const context = currentContext();
      if (!context) return;
      context.agentSessions.renameCurrent(title);
      context.uiBridge.syncAgentStatusItems();
    },
    listRunningAgents() {
      return currentContext()?.agentSessions.list() ?? [];
    },
    clearIdleAgents() {
      const context = currentContext();
      if (!context) return { cleared: [], remaining: [] };
      const result = context.agentSessions.clearIdleSessions();
      context.uiBridge.syncAgentStatusItems();
      return result;
    },
    newAgentSession() {
      const context = currentContext();
      const record = context?.agentSessions.createSession();
      if (!context || !record) throw new Error('Application is not ready');
      const session = context.agentSessions.findById(record.id);
      if (session) context.uiBridge.watchAgent(session.agent);
      context.uiBridge.syncAgentStatusItems();
      return record;
    },
    submitAgentSessionInput(id, text) {
      const context = currentContext();
      if (!context) throw new Error('Application is not ready');
      const session = context.agentSessions.findById(id);
      if (!session) throw new Error(`Agent session not found: ${id}`);
      context.uiBridge.watchAgent(session.agent);
      return context.runtime.submitToAgent(session.agent, session.sessionController, text, { source: 'command' });
    },
    forkCurrentAgent() {
      const context = currentContext();
      if (!context) throw new Error('Application is not ready');

      const sourceSession = context.agentSessions.current();
      const sourceWasRunning = sourceSession.agent.isRunning;
      const historyConversationCount = sourceSession.agent.toConversationMessages().length;
      const uiConversationCount = sourceSession.uiState.conversationMessages.length;
      const sourceSnapshot = sourceSession.agent.getForkSnapshot({
        dropLastUserMessageAndAfter: sourceWasRunning && uiConversationCount <= historyConversationCount,
      });
      const created = context.agentSessions.createSession();
      const targetSession = context.agentSessions.findById(created.id);
      if (!targetSession) throw new Error(`Forked agent session not found: ${created.id}`);

      targetSession.agent.loadSnapshot(sourceSnapshot);
      targetSession.sessionController.saveCurrent();
      targetSession.uiState = normalizeUiState({
        ...targetSession.uiState,
        conversationMessages: targetSession.agent.toConversationMessages(),
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        messageBarMessages: [],
        logEntries: [],
        agentTurnLogItems: [],
        uiLog: [],
        thinkingText: '',
        pluginUIs: [],
        workingStatus: { type: 'idle' },
        lastTurnOutcome: 'idle',
        contextSize: sourceSnapshot.lastUsage?.totalTokens ?? 0,
        cachedTokenRate: calculateCachedTokenRate(sourceSnapshot.usageHistory),
      });
      const record = context.agentSessions.list().find((agent) => agent.id === created.id) ?? created;
      micaLogger.logRuntime('plugin.fork', 'snapshot:loaded', {
        id: created.id,
        messages: sourceSnapshot.messages.length,
        sourceWasRunning,
      });
      return { ...record, sourceWasRunning };
    },
    switchAgentSession(id) {
      const context = currentContext();
      if (!context) throw new Error('Application is not ready');

      const previous = context.agentSessions.current();
      previous.uiState = normalizeUiState(captureSessionUi());
      const record = context.agentSessions.switchTo(id);
      if (!record) throw new Error(`Agent session not found: ${id}`);
      const session = context.agentSessions.current();
      micaBuiltinCommands.syncConfigFromAgent(session.agent);
      context.runtime.switchSession(session.agent, session.sessionController);
      context.uiBridge.switchAgent(session.agent);
      restoreSessionUi(session.agent, session.uiState);
      return record;
    },
    refreshCurrentAgentSessionUi() {
      const context = currentContext();
      const session = context?.agentSessions.current();
      if (!session) return;
      session.titleOverride = session.sessionController.getCurrentTitle();
      session.uiState = normalizeUiState(captureSessionUi());
      context?.uiBridge.syncAgentStatusItems();
    },
    getRewindPreview() {
      const runtime = currentContext()?.runtime;
      if (!runtime) return { ok: false, message: 'rewind: Application is not ready' };
      return runtime.getRewindPreview();
    },
    applyRewind(id) {
      const context = currentContext();
      if (!context) throw new Error('Application is not ready');
      const result = context.runtime.applyRewind(id);
      const session = context.agentSessions.current();
      const snapshot = session.agent.getSnapshot();
      session.uiState = normalizeUiState({
        ...session.uiState,
        conversationMessages: session.agent.toConversationMessages(),
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        messageBarMessages: [],
        logEntries: [],
        agentTurnLogItems: [],
        thinkingText: '',
        pluginUIs: [],
        workingStatus: { type: 'idle' },
        lastTurnOutcome: 'idle',
        contextSize: snapshot.lastUsage?.totalTokens ?? 0,
        cachedTokenRate: calculateCachedTokenRate(snapshot.usageHistory),
      });
      restoreSessionUi(session.agent, session.uiState);
      syncModelDisplay(session.agent);
      session.sessionController.saveCurrent({ allowEmpty: true });
      context.uiBridge.syncAgentStatusItems();
      return result;
    },
    async runExclusiveTask(agent, options, task) {
      const context = currentContext();
      if (!context) return task();
      const target = resolveCommandAgent(agent);
      const release = context.runtime.beginExclusiveTask(target, options.statusText);
      const status: MicaUiWorkingStatus = {
        type: 'plugin_task',
        text: options.statusText,
        level: options.level,
      };
      setAgentWorkingStatus(context, target, status, options.ownerSessionId);
      try {
        return await task();
      } finally {
        release();
        setAgentWorkingStatus(context, target, { type: 'idle' }, options.ownerSessionId);
      }
    },
    async compact(agent, sessionController, ownerSessionId, options) {
      const context = currentContext();
      const ownerSession = ownerSessionId
        ? context?.agentSessions.findById(ownerSessionId)
        : context?.agentSessions.current();
      const concreteAgent = ownerSession?.agent ?? (agent as AgentRuntime);
      const concreteSessionController = ownerSession?.sessionController ?? (sessionController as SessionController);
      const snapshot = concreteAgent.getSnapshot();
      if (context) {
        setAgentWorkingStatus(
          context,
          concreteAgent,
          { type: 'plugin_task', text: 'compact: building transcript' },
          ownerSession?.id,
        );
      }
      const service = new micaContext.CompactionService();
      const result = await service.compact({
        messages: snapshot.messages,
        options,
        summarize: async (transcript, prompt) => {
          if (context) {
            setAgentWorkingStatus(
              context,
              concreteAgent,
              { type: 'plugin_task', text: 'compact: summarizing context' },
              ownerSession?.id,
            );
          }
          const subAgent = concreteAgent.createSubAgent({
            systemPrompt: prompt,
          });
          return subAgent.query(
            [
              'Summarize this conversation into a compact checkpoint for the next coding agent.',
              'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
              'Return only the requested <analysis> and <summary> blocks.',
              '',
              transcript,
            ].join('\n'),
          );
        },
      });

      if (result.preview) return result;

      if (context) {
        setAgentWorkingStatus(
          context,
          concreteAgent,
          { type: 'plugin_task', text: 'compact: applying checkpoint' },
          ownerSession?.id,
        );
      }
      concreteAgent.loadSnapshot({
        ...snapshot,
        messages: result.messages,
        usageHistory: [],
        lastUsage: undefined,
      });
      const conversationMessages = hideCompactArtifacts(concreteAgent.toConversationMessages());
      const nextUiState = normalizeUiState({
        ...(ownerSession?.uiState ?? captureSessionUi()),
        conversationMessages,
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        contextSize: 0,
        cachedTokenRate: 0,
      });
      if (ownerSession) ownerSession.uiState = nextUiState;
      if (!ownerSession || context?.agentSessions.current().id === ownerSession.id) {
        micaUi.conversation.setMessages(conversationMessages);
        micaUi.conversation.clearResponseText();
        micaUi.conversation.clearPendingInput();
        micaUi.panels.contextSize.set(0);
        micaUi.panels.cachedTokenRate.set(0);
        if (ownerSession) ownerSession.uiState = normalizeUiState(captureSessionUi());
      }
      concreteSessionController.saveCurrent();
      return result;
    },
    async recap(agent, ownerSessionId, options) {
      const context = currentContext();
      const ownerSession = ownerSessionId
        ? context?.agentSessions.findById(ownerSessionId)
        : context?.agentSessions.current();
      const concreteAgent = ownerSession?.agent ?? (agent as AgentRuntime);
      const snapshot = concreteAgent.getSnapshot();
      if (snapshot.messages.length === 0) {
        throw new Error('当前会话还没有可总结的内容');
      }
      const subAgent = concreteAgent.createSubAgent({
        systemPrompt: buildRecapPrompt(options?.customInstructions),
      });
      const summary = cleanRecapSummary(
        await subAgent.query(
          [
            'Create a recap of this conversation.',
            'Do not mention that this instruction exists.',
            '',
            buildRecapTranscript(snapshot.messages),
          ].join('\n'),
        ),
      );
      if (!summary) throw new Error('Recap summary is empty');
      showRecapForSession(context, ownerSession?.id ?? ownerSessionId, summary, formatRecapCommand(options));
      return { summary, messageCount: snapshot.messages.length };
    },
    requestExit() {
      micaUi.terminalInput.requestExit();
    },
  };
}
