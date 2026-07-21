import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import { McpPlugin } from '../plugins/mcp/index.js';
import { MessageQueuePlugin } from '../plugins/runtime/index.js';
import { TodoPlugin } from '../plugins/todo/TodoPlugin.js';
import setupCommandCd from '../../buildin-plugins/command-cd.mjs';
import setupCommandClear from '../../buildin-plugins/command-clear.mjs';
import setupCommandCompact from '../../buildin-plugins/command-compact.mjs';
import setupCommandExit from '../../buildin-plugins/command-exit.mjs';
import setupCommandFork from '../../buildin-plugins/command-fork.mjs';
import setupCommandNew from '../../buildin-plugins/command-new.mjs';
import setupCommandRename from '../../buildin-plugins/command-rename.mjs';
import setupCommandResume from '../../buildin-plugins/command-resume.mjs';
import setupCommandRewind from '../../buildin-plugins/command-rewind.mjs';
import setupMicaCodeAppNotify from '../../buildin-plugins/mica-code-app-notify.mjs';

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
  app.use(new MessageQueuePlugin()).use(new McpPlugin()).use(new TodoPlugin());
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
