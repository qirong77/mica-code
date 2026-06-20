import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import { McpPlugin } from '../plugins/mcp/index.js';
import { MessageQueuePlugin } from '../plugins/runtime/index.js';

type PluginHost = {
  use(plugin: MicaPlugin): PluginHost;
};

export function useBuiltinPlugins(
  app: PluginHost,
  agent: AgentRuntime,
  sessionController: SessionController,
): PluginHost {
  return app
    .use(new BuiltInCommandsPlugin(agent, sessionController))
    .use(new MessageQueuePlugin())
    .use(new McpPlugin());
}
