import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { clearUI, showMessage, syncModelDisplay } from '../../runtime/uiBridge.js';
import { getActiveApplication } from '../../app/Application.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { listRunningAgents } from '../../agents/agentRegistry.js';
import { micaContext } from '@packages/mica-context/index.js';
import { micaIpc } from '@packages/mica-ipc/index.js';
import { RemoteRuntimeClientAdapter } from '../../app/adapters/RemoteRuntimeClientAdapter.js';

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

  return [
    micaBuiltinCommands.createClearCommand(agent, sessionController, services),
    micaBuiltinCommands.createResumeCommand(agent, sessionController, services),
    micaBuiltinCommands.createProviderCommand(agent, services),
    micaBuiltinCommands.createModelCommand(agent, services),
    micaBuiltinCommands.createEffortCommand(agent, services),
    micaBuiltinCommands.createStatusCommand(agent),
    micaBuiltinCommands.createLogsCommand(),
    micaBuiltinCommands.createMcpCommand(services),
    micaBuiltinCommands.createSkillsCommand(),
    micaBuiltinCommands.createGitDiffContextCommand(),
    micaBuiltinCommands.createCommitCommand(agent),
    micaBuiltinCommands.createLogExportCommand(agent, sessionController),
    micaBuiltinCommands.createAgentsCommand(services),
    micaBuiltinCommands.createCompactCommand(agent, sessionController, services),
  ];
}

function createCommandRuntimeServices(): CommandRuntimeServices {
  return {
    clearUI(agent, sessionController) {
      const context = getActiveApplication()?.activeContext;
      context?.runtime.clear();
      context?.uiBridge.clearToolLogs();
      clearUI(agent as AgentRuntime, sessionController as SessionController | undefined);
    },
    showMessage,
    syncModelDisplay,
    isAgentRunning() {
      return getActiveApplication()?.activeContext?.runtime.getStatus().running ?? false;
    },
    listRunningAgents,
    async attachAgent(agent) {
      const app = getActiveApplication();
      const uiBridge = app?.activeContext?.uiBridge;
      if (agent.pid === process.pid) {
        await uiBridge?.detachActiveController();
        showMessage('Returned to local agent', 4000);
        return 'Returned to local agent';
      }

      await uiBridge?.detachActiveController();

      const client = new micaIpc.AgentIpcClient(agent.ipc.socketPath);
      const controllerAgentId = app?.activeContext?.agentRegistry.id ?? `${process.pid}`;
      await client.connect();
      await client.hello(controllerAgentId);
      const attachResult = (await client.attach({
        mode: 'control',
        takeover: false,
        controllerAgentId,
      })) as { snapshot: import('@packages/mica-runtime/index.js').RuntimeViewSnapshot };
      uiBridge?.setActiveController(new RemoteRuntimeClientAdapter(client, attachResult.snapshot, controllerAgentId));
      showMessage(`Attached to ${agent.cwd}`, 4000);
      return `Attached to ${agent.cwd}`;
    },
    async detachAgent() {
      await getActiveApplication()?.activeContext?.uiBridge.detachActiveController();
      return 'Detached; returned to local agent';
    },
    async compact(agent, sessionController) {
      const concreteAgent = agent as AgentRuntime;
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
      micaUi.conversation.setMessages(concreteAgent.toConversationMessages());
      micaUi.conversation.clearResponseText();
      micaUi.conversation.clearPendingInput();
      (sessionController as import('../../session/SessionController.js').SessionController).saveCurrent();
      return result;
    },
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
