import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { readDisabledPluginIds, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { officialPlugins } from '@packages/mica-official-plugins/index.js';
import { APP_NAME } from '@packages/mica-config/brand.js';
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
  setupFileMention,
  setupLoop,
  setupMcp,
  setupMessageQueue,
  setupMicaCodeAppNotify,
  setupSessionAutonomy,
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
    .use(createBuiltinFilePlugin('file-mention', 'File Mention', setupFileMention, true));
  for (const plugin of enabledOfficialPlugins()) app.use(plugin);
  app.use({
    id: 'builtin.mica-code-app-notify',
    name: `Built-in ${APP_NAME} App Notify`,
    required: false,
    setup: setupMicaCodeAppNotify,
  });
  return app;
}

/**
 * 官方插件是随产品分发的，但可以在配置页里停用（`$MICA_HOME/plugins-state.json`）。
 * 停用发生在注册阶段，所以它们的工具、命令、钩子完全不会被创建。
 */
function enabledOfficialPlugins(): MicaPlugin[] {
  const disabled = readDisabledPluginIds();
  return officialPlugins.filter((plugin) => !disabled.has(plugin.id));
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
