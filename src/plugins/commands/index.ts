import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';
import type { SessionController } from '../../session/SessionController.js';
import { createActiveAgentProxy, createActiveSessionControllerProxy } from './activeCommandProxies.js';
import { createCommandRuntimeServices } from './commandRuntimeServices.js';

const ALLOW_DURING_TURN_COMMANDS = new Set(['log', 'status', 'context', 'agents', 'new', 'fork', 'exit', 'copy']);
type BuiltInCommandItem = Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];

function currentContext(): ApplicationContext | null {
  return getActiveContext<ApplicationContext>();
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
    micaBuiltinCommands.createContextCommand(activeAgent),
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
