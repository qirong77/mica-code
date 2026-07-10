import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SessionController } from '../../session/SessionController.js';
import { createActiveAgentProxy, createActiveSessionControllerProxy } from './activeCommandProxies.js';
import { createCommandRuntimeServices } from './commandRuntimeServices.js';
import { registerCommand, type BuiltInCommandItem } from './registerCommand.js';

const ALLOW_DURING_TURN_COMMANDS = new Set([
  'status',
  'context',
  'config',
  'doctor',
  'new',
  'fork',
  'exit',
  'copy',
  'rename',
  'task',
]);

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
    micaBuiltinCommands.createConfigCommand(services),
    micaBuiltinCommands.createDoctorCommand(activeAgent),
    micaBuiltinCommands.createNewCommand(services),
    micaBuiltinCommands.createForkCommand(services),
    micaBuiltinCommands.createRewindCommand(services),
    micaBuiltinCommands.createMcpCommand(services),
    micaBuiltinCommands.createSkillsCommand(),
    micaBuiltinCommands.createCommitCommand(activeAgent, services),
    micaBuiltinCommands.createTaskCommand(services),
    micaBuiltinCommands.createCompactCommand(activeAgent, activeSessionController, services),
    micaBuiltinCommands.createRecapCommand(activeAgent, services),
    micaBuiltinCommands.createExitCommand(services),
    micaBuiltinCommands.createCopyCommand(services),
    micaBuiltinCommands.createRenameCommand(activeSessionController, services),
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
      registerCommand(ctx, command, { allowDuringTurn: ALLOW_DURING_TURN_COMMANDS.has(command.name) });
    }
  }
}
