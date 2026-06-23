import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { calculateCachedTokenRate } from '@packages/mica-agent/index.js';
import { micaUi, type MicaUiWorkingStatus } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { clearUI, showMessage as showGlobalMessage, syncModelDisplay } from '../../runtime/uiBridge.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';
import type {
  CommandAgent,
  CommandRuntimeServices,
  CommandSessionController,
} from '@packages/mica-builtin-commands/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import { normalizeUiState, type TerminalAgentUiState } from '../../agents/terminalAgentSessions.js';

type BuiltInCommandItem = Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
const ALLOW_DURING_TURN_COMMANDS = new Set(['log', 'status', 'agents', 'new', 'fork', 'exit', 'copy']);

function currentContext(): ApplicationContext | null {
  return getActiveContext<ApplicationContext>();
}

export class BuiltInCommandsPlugin extends micaPlugin.Plugin {
  constructor(
    private readonly agent: AgentRuntime,
    private readonly sessionController: SessionController,
  ) {
    super({
      id: 'builtin.commands',
      name: 'Built-in Commands',
      required: true,
    });
  }

  setup(ctx: PluginContext): void {
    const builtInCommands = createBuiltInCommands(this.agent, this.sessionController);

    for (const command of builtInCommands) {
      const disposable = ctx.commands.register({
        name: command.name,
        description: command.description,
        scope: 'local-only',
        allowDuringTurn: ALLOW_DURING_TURN_COMMANDS.has(command.name),
        pluginId: ctx.pluginId,
        async handler(_commandCtx, args) {
          if (command.name !== 'log') micaBuiltinCommands.closeLogPanel();
          micaLogger.logRuntime('plugin', 'action:start', { name: command.name, arg: args });
          try {
            await command.action(args || undefined);
            micaLogger.logRuntime('plugin', 'action:done', { name: command.name });
            return { ok: true };
          } catch (error) {
            micaLogger.logRuntime('plugin', 'action:error', { name: command.name, error: formatError(error) }, 'error');
            throw error;
          }
        },
      });
      ctx.onDispose(() => disposable.dispose());
    }

    micaUi.dropdown.setQuickCommands(
      ctx.commands.list().map((command) => ({
        name: command.name,
        description: command.description ?? '',
        action: (arg?: string) => {
          const text = `/${command.name}${arg ? ` ${arg}` : ''}`;
          const runtime = currentContext()?.runtime;
          if (runtime) {
            void runtime.submit(text, { source: 'command' });
            return;
          }
          void ctx.commands.execute(text, {});
        },
      })),
    );

    micaLogger.logRuntime('plugin', 'registered', { count: builtInCommands.length });
  }
}

function createBuiltInCommands(agent: AgentRuntime, sessionController: SessionController): BuiltInCommandItem[] {
  const services = createCommandRuntimeServices();
  const activeAgent = createActiveAgentProxy(agent);
  const activeSessionController = createActiveSessionControllerProxy(sessionController);

  return [
    micaBuiltinCommands.createClearCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createResumeCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createProviderCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createModelCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createEffortCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createStatusCommand(activeAgent),
    micaBuiltinCommands.createNewCommand(services),
    micaBuiltinCommands.createForkCommand(services),
    micaBuiltinCommands.createRewindCommand(services),
    micaBuiltinCommands.createLogCommand(activeAgent, services),
    micaBuiltinCommands.createMcpCommand(services),
    micaBuiltinCommands.createSkillsCommand(),
    micaBuiltinCommands.createGitDiffContextCommand(services),
    micaBuiltinCommands.createCommitCommand(activeAgent, services),
    micaBuiltinCommands.createAgentsCommand(services),
    micaBuiltinCommands.createCompactCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createExitCommand(services),
    micaBuiltinCommands.createCopyCommand(services),
  ];
}

function createCommandRuntimeServices(): CommandRuntimeServices {
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
      if (session) session.uiState = normalizeUiState(captureSessionUi());
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
      session.uiState = normalizeUiState(captureSessionUi());
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
    async compact(agent, sessionController, ownerSessionId) {
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
        summarize: async (transcript) => {
          if (context) {
            setAgentWorkingStatus(
              context,
              concreteAgent,
              { type: 'plugin_task', text: 'compact: summarizing context' },
              ownerSession?.id,
            );
          }
          const subAgent = concreteAgent.createSubAgent({
            systemPrompt: [
              'You create compact checkpoints for coding-agent conversations.',
              'Use only facts visible in the transcript. Do not infer hidden intent.',
              'Return markdown with these exact sections:',
              '## User Intent',
              '## Current State',
              '## Constraints and Preferences',
              '## Files Inspected',
              '## Files Modified',
              '## Tool Results and Evidence',
              '## Key Decisions',
              '## Errors and Fixes',
              '## Validation',
              '## Pending Work',
              '## Immediate Next Step',
            ].join('\n'),
          });
          return subAgent.query(
            [
              'Summarize this conversation into a compact checkpoint for the next coding agent.',
              'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
              '',
              transcript,
            ].join('\n'),
          );
        },
      });

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
      const nextUiState = normalizeUiState({
        ...(ownerSession?.uiState ?? captureSessionUi()),
        conversationMessages: concreteAgent.toConversationMessages(),
        responseText: '',
        pendingInputs: [],
        pendingQueueMode: null,
        contextSize: 0,
        cachedTokenRate: 0,
      });
      if (ownerSession) ownerSession.uiState = nextUiState;
      if (!ownerSession || context?.agentSessions.current().id === ownerSession.id) {
        micaUi.conversation.setMessages(concreteAgent.toConversationMessages());
        micaUi.conversation.clearResponseText();
        micaUi.conversation.clearPendingInput();
        micaUi.panels.contextSize.set(0);
        micaUi.panels.cachedTokenRate.set(0);
        if (ownerSession) ownerSession.uiState = normalizeUiState(captureSessionUi());
      }
      concreteSessionController.saveCurrent();
      return result;
    },
    requestExit() {
      const context = currentContext();
      if (context) {
        const session = context.agentSessions.current();
        if (session.agent.isRunning) session.agent.abort();
      }
      process.exit(0);
    },
  };
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
    contextSize: micaUi.panels.contextSize.get(),
    cachedTokenRate: micaUi.panels.cachedTokenRate.get(),
  };
}

function createActiveAgentProxy(fallback: AgentRuntime): CommandAgent {
  const current = () => currentContext()?.agentSessions.current().agent ?? fallback;
  return {
    get config() {
      return current().config;
    },
    get currentRunId() {
      return current().currentRunId;
    },
    get isRunning() {
      return current().isRunning;
    },
    reloadConfig(resetClient?: boolean) {
      current().reloadConfig(resetClient);
    },
    createSubAgent(options?: { systemPrompt?: string; [key: string]: unknown }) {
      return current().createSubAgent(options);
    },
    getSnapshot() {
      return current().getSnapshot();
    },
  };
}

function createActiveSessionControllerProxy(fallback: SessionController): CommandSessionController {
  const current = () => currentContext()?.agentSessions.current().sessionController ?? fallback;
  return {
    list(limit?: number) {
      return current().list(limit);
    },
    resume(id: string) {
      return current().resume(id);
    },
    startNewSession() {
      current().startNewSession();
    },
    saveCurrent() {
      current().saveCurrent();
    },
  };
}

function resolveCommandAgent(agent: CommandAgent): AgentRuntime {
  if (agent instanceof AgentRuntime) return agent;
  const current = currentContext()?.agentSessions.current().agent;
  if (current) return current;
  return agent as AgentRuntime;
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
