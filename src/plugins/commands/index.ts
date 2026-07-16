import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { commandHostToken, type BuiltInCommandItem } from '@packages/mica-builtin-commands/commandHost.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { createActiveAgentProxy, createActiveSessionControllerProxy } from './activeCommandProxies.js';
import { createCommandRuntimeServices } from './commandRuntimeServices.js';
import { registerCommand } from './registerCommand.js';

const ALLOW_DURING_TURN_COMMANDS = new Set(['status', 'context', 'config', 'task', 'commit', 'diff']);

function createBuiltInCommands(
  agent: AgentRuntime,
  sessionController: SessionController,
  tracker: InstanceType<typeof micaBuiltinCommands.AgentChangeTracker>,
): {
  commands: BuiltInCommandItem[];
  services: ReturnType<typeof createCommandRuntimeServices>;
  activeAgent: ReturnType<typeof createActiveAgentProxy>;
  activeSessionController: ReturnType<typeof createActiveSessionControllerProxy>;
} {
  const services = createCommandRuntimeServices();
  const activeAgent = createActiveAgentProxy(agent);
  const activeSessionController = createActiveSessionControllerProxy(sessionController);

  return {
    services,
    activeAgent,
    activeSessionController,
    commands: [
      micaBuiltinCommands.createProviderCommand(activeAgent, activeSessionController, services),
      micaBuiltinCommands.createModelCommand(activeAgent, activeSessionController, services),
      micaBuiltinCommands.createEffortCommand(activeAgent, activeSessionController, services),
      micaBuiltinCommands.createRoleCommand(activeAgent, activeSessionController, services),
      micaBuiltinCommands.createStatusCommand(activeAgent, activeSessionController),
      micaBuiltinCommands.createContextCommand(activeAgent),
      micaBuiltinCommands.createConfigCommand(activeAgent, services),
      micaBuiltinCommands.createMcpCommand(services),
      micaBuiltinCommands.createSkillsCommand(),
      micaBuiltinCommands.createDiffCommand(activeAgent, services, tracker),
      micaBuiltinCommands.createCommitCommand(activeAgent, services, tracker),
      micaBuiltinCommands.createTaskCommand(services),
    ],
  };
}

export class BuiltInCommandsPlugin extends micaPlugin.Plugin {
  constructor(
    private readonly agent: AgentRuntime,
    private readonly sessionController: SessionController,
  ) {
    super({
      id: 'builtin.commands',
      name: 'Built-in Commands',
      priority: -1000,
      required: true,
    });
  }

  setup(ctx: PluginContext): void {
    const tracker = new micaBuiltinCommands.AgentChangeTracker();
    const observer = micaTools.observeExecution(tracker.createObserver());
    ctx.onDispose(() => observer.dispose());
    const { commands, services, activeAgent, activeSessionController } = createBuiltInCommands(
      this.agent,
      this.sessionController,
      tracker,
    );
    const hostRegistration = ctx.services.register(commandHostToken, {
      agent: activeAgent,
      sessionController: activeSessionController,
      services,
      registerCommand,
    });
    ctx.onDispose(() => hostRegistration.dispose());

    for (const command of commands) {
      registerCommand(ctx, command, { allowDuringTurn: ALLOW_DURING_TURN_COMMANDS.has(command.name) });
    }

    micaUi.terminalInput.setOnCycleRole(() => {
      micaBuiltinCommands.cycleNextRole(activeAgent, activeSessionController, services);
    });
    ctx.onDispose(() => {
      micaUi.terminalInput.setOnCycleRole(null);
    });
  }
}
