import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import {
  setupCommandCd,
  setupCommandClear,
  setupCommandCompact,
  setupCommandExit,
  setupCommandFork,
  setupCommandMemory,
  setupCommandNew,
  setupCommandRename,
  setupCommandResume,
  setupCommandRewind,
  setupContextPressure,
  setupFileMention,
  setupLoop,
  setupMcp,
  setupMessageQueue,
  setupMicaCodeAppNotify,
  setupSessionAutonomy,
  TodoPlugin,
} from '@packages/mica-builtin-commands/index.js';

type PluginHost = {
  use(plugin: MicaPlugin): PluginHost;
};

export function useBuiltinPlugins(
  app: PluginHost,
  agent: AgentRuntime,
  sessionController: SessionController,
): PluginHost {
  app.use(new BuiltInCommandsPlugin(agent, sessionController));
  for (const plugin of builtinCommandFilePlugins()) app.use(plugin);
  app
    .use(createBuiltinFilePlugin('runtime.messageQueue', 'Message Queue', setupMessageQueue))
    .use(createBuiltinFilePlugin('mcp', 'MCP', setupMcp))
    .use(createBuiltinFilePlugin('command-memory', 'Command Memory', setupCommandMemory))
    .use(createBuiltinFilePlugin('session-autonomy', 'Session Autonomy', setupSessionAutonomy))
    .use(createBuiltinFilePlugin('context-pressure', 'Context Pressure', setupContextPressure))
    .use(new TodoPlugin())
    .use(createBuiltinFilePlugin('file-mention', 'File Mention', setupFileMention, true));
  app.use({
    id: 'builtin.mica-code-app-notify',
    name: 'Built-in Mica Code App Notify',
    required: false,
    setup: setupMicaCodeAppNotify,
  });
  return app;
}

function builtinCommandFilePlugins(): MicaPlugin[] {
  return [
    createBuiltinCommandFilePlugin('cd', setupCommandCd),
    createBuiltinCommandFilePlugin('clear', setupCommandClear),
    createBuiltinCommandFilePlugin('compact', setupCommandCompact),
    createBuiltinCommandFilePlugin('exit', setupCommandExit),
    createBuiltinCommandFilePlugin('fork', setupCommandFork),
    createBuiltinCommandFilePlugin('new', setupCommandNew),
    createBuiltinCommandFilePlugin('rename', setupCommandRename),
    createBuiltinCommandFilePlugin('resume', setupCommandResume),
    createBuiltinCommandFilePlugin('rewind', setupCommandRewind),
    createBuiltinCommandFilePlugin('loop', setupLoop),
  ];
}

function createBuiltinCommandFilePlugin(name: string, setup: MicaPlugin['setup']): MicaPlugin {
  return {
    id: `builtin.command.${name}`,
    name: `Built-in /${name} Command`,
    dependencies: ['builtin.commands'],
    required: true,
    setup,
  };
}

function createBuiltinFilePlugin(id: string, name: string, setup: MicaPlugin['setup'], required = false): MicaPlugin {
  return {
    id: `builtin.${id}`,
    name: `Built-in ${name}`,
    required,
    setup,
  };
}
