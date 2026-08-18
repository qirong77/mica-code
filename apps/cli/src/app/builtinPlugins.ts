import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import setupFileMention from '../../../../plugins/builtin/file-mention.js';
import setupMcp from '../../../../plugins/builtin/mcp.mjs';
import setupMessageQueue from '../../../../plugins/builtin/message-queue.js';
import setupCommandMemory from '../../../../plugins/builtin/command-memory.js';
import { TodoPlugin } from '../../../../plugins/builtin/todo/TodoPlugin.js';
import setupCommandCd from '../../../../plugins/builtin/command-cd.mjs';
import setupCommandClear from '../../../../plugins/builtin/command-clear.mjs';
import setupCommandCompact from '../../../../plugins/builtin/command-compact.mjs';
import setupCommandExit from '../../../../plugins/builtin/command-exit.mjs';
import setupCommandFork from '../../../../plugins/builtin/command-fork.mjs';
import setupCommandNew from '../../../../plugins/builtin/command-new.mjs';
import setupCommandRename from '../../../../plugins/builtin/command-rename.mjs';
import setupCommandResume from '../../../../plugins/builtin/command-resume.mjs';
import setupCommandRewind from '../../../../plugins/builtin/command-rewind.mjs';
import setupLoop from '../../../../plugins/builtin/loop.js';
import setupMicaCodeAppNotify from '../../../../plugins/builtin/mica-code-app-notify.mjs';
import setupSessionAutonomy from '../../../../plugins/builtin/session-autonomy/SessionAutonomyPlugin.js';
import setupContextPressure from '../../../../plugins/builtin/context-pressure/ContextPressurePlugin.js';

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
