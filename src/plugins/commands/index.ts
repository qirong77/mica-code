import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { clearUI, showMessage as showGlobalMessage, syncModelDisplay } from '../../runtime/uiBridge.js';
import { getActiveApplication } from '../../app/Application.js';
import type {
  CommandAgent,
  CommandRuntimeServices,
  CommandSessionController,
} from '@packages/mica-builtin-commands/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import { normalizeUiState, type TerminalAgentUiState } from '../../agents/terminalAgentSessions.js';

type BuiltInCommandItem = Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];

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
        hidden: command.hidden,
        scope: 'local-only',
        allowDuringTurn: true,
        pluginId: ctx.pluginId,
        async handler(_commandCtx, args) {
          if (command.name !== 'logs') micaBuiltinCommands.closeLogsPanel();
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
      ctx.commands.list({ includeHidden: true }).map((command) => ({
        name: command.name,
        description: command.description ?? '',
        hidden: command.hidden,
        action: (arg?: string) => {
          void ctx.commands.execute(`/${command.name}${arg ? ` ${arg}` : ''}`, {});
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
    micaBuiltinCommands.createProviderCommand(activeAgent, services),
    micaBuiltinCommands.createModelCommand(activeAgent, services),
    micaBuiltinCommands.createEffortCommand(activeAgent, services),
    micaBuiltinCommands.createStatusCommand(activeAgent),
    micaBuiltinCommands.createNewCommand(services),
    micaBuiltinCommands.createLogsCommand(),
    micaBuiltinCommands.createMcpCommand(services),
    micaBuiltinCommands.createSkillsCommand(),
    micaBuiltinCommands.createGitDiffContextCommand(services),
    micaBuiltinCommands.createCommitCommand(activeAgent, services),
    micaBuiltinCommands.createLogExportCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createAgentsCommand(services),
    micaBuiltinCommands.createCompactCommand(activeAgent, activeSessionController, services),
  ];
}

function createCommandRuntimeServices(): CommandRuntimeServices {
  return {
    clearUI(agent, sessionController) {
      const context = getActiveApplication()?.activeContext;
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
      const context = getActiveApplication()?.activeContext;
      const session = ownerSessionId
        ? context?.agentSessions.findById(ownerSessionId)
        : context?.agentSessions.current();
      if (context && session) {
        context.uiBridge.showMessageForAgent(session.agent, text, ttl);
        return;
      }
      showGlobalMessage(text, ttl);
    },
    syncModelDisplay(_agent) {
      const session = getActiveApplication()?.activeContext?.agentSessions.current();
      syncModelDisplay(session?.agent ?? (_agent as AgentRuntime));
    },
    isAgentRunning() {
      return getActiveApplication()?.activeContext?.runtime.getStatus().running ?? false;
    },
    getCurrentAgentSessionId() {
      return getActiveApplication()?.activeContext?.agentSessions.current().id;
    },
    getCurrentAgent() {
      return getActiveApplication()?.activeContext?.agentSessions.current().agent;
    },
    listRunningAgents() {
      return getActiveApplication()?.activeContext?.agentSessions.list() ?? [];
    },
    newAgentSession() {
      const session = getActiveApplication()?.activeContext?.agentSessions.createSession();
      if (!session) throw new Error('Application is not ready');
      return session;
    },
    switchAgentSession(id) {
      const app = getActiveApplication();
      const context = app?.activeContext;
      if (!context) throw new Error('Application is not ready');

      const previous = context.agentSessions.current();
      previous.uiState = normalizeUiState(captureSessionUi());
      const record = context.agentSessions.switchTo(id);
      if (!record) throw new Error(`Agent session not found: ${id}`);
      const session = context.agentSessions.current();
      context.runtime.switchSession(session.agent, session.sessionController);
      context.uiBridge.switchAgent(session.agent);
      restoreSessionUi(session.agent, session.uiState);
      return record;
    },
    refreshCurrentAgentSessionUi() {
      const context = getActiveApplication()?.activeContext;
      const session = context?.agentSessions.current();
      if (!session) return;
      session.uiState = normalizeUiState(captureSessionUi());
    },
    async compact(agent, sessionController, ownerSessionId) {
      const context = getActiveApplication()?.activeContext;
      const ownerSession = ownerSessionId
        ? context?.agentSessions.findById(ownerSessionId)
        : context?.agentSessions.current();
      const concreteAgent = ownerSession?.agent ?? (agent as AgentRuntime);
      const concreteSessionController = ownerSession?.sessionController ?? (sessionController as SessionController);
      const snapshot = concreteAgent.getSnapshot();
      const service = new micaContext.CompactionService();
      const result = await service.compact({
        messages: snapshot.messages,
        summarize: async (transcript) => {
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

      concreteAgent.loadSnapshot({
        ...snapshot,
        messages: result.messages,
        usageHistory: snapshot.usageHistory,
        lastUsage: snapshot.lastUsage,
      });
      const nextUiState = normalizeUiState({
        ...(ownerSession?.uiState ?? captureSessionUi()),
        conversationMessages: concreteAgent.toConversationMessages(),
        responseText: '',
        pendingInputs: [],
      });
      if (ownerSession) ownerSession.uiState = nextUiState;
      if (!ownerSession || context?.agentSessions.current().id === ownerSession.id) {
        micaUi.conversation.setMessages(concreteAgent.toConversationMessages());
        micaUi.conversation.clearResponseText();
        micaUi.conversation.clearPendingInput();
        if (ownerSession) ownerSession.uiState = normalizeUiState(captureSessionUi());
      }
      concreteSessionController.saveCurrent();
      return result;
    },
  };
}

function captureSessionUi(): TerminalAgentUiState {
  return {
    conversationMessages: micaUi.conversation.messages.get(),
    responseText: micaUi.conversation.responseText.get(),
    pendingInputs: micaUi.conversation.pendingInputs.get(),
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
  const current = () => getActiveApplication()?.activeContext?.agentSessions.current().agent ?? fallback;
  return {
    get config() {
      return current().config;
    },
    get currentRunId() {
      return current().currentRunId;
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
  const current = () => getActiveApplication()?.activeContext?.agentSessions.current().sessionController ?? fallback;
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

function restoreSessionUi(agent: AgentRuntime, uiState: TerminalAgentUiState): void {
  const snapshot = agent.getSnapshot();
  micaUi.conversation.setMessages(uiState.conversationMessages.length > 0 ? uiState.conversationMessages : agent.toConversationMessages());
  micaUi.conversation.setResponseText(uiState.responseText);
  micaUi.conversation.setPendingInputs(uiState.pendingInputs);
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
    const totalInput = snapshot.usageHistory.reduce((sum, usage) => sum + usage.inputTokens, 0);
    const totalCached = snapshot.usageHistory.reduce((sum, usage) => sum + (usage.cachedInputTokens ?? 0), 0);
    micaUi.panels.cachedTokenRate.set(totalInput > 0 ? Math.max(0, totalCached / totalInput) : 0);
  } else {
    micaUi.panels.contextSize.set(0);
    micaUi.panels.cachedTokenRate.set(0);
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
