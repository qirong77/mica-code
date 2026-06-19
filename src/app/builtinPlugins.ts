import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import { McpPlugin } from '../plugins/mcp/index.js';
import { MessageQueuePlugin } from '../plugins/runtime/index.js';
import type { Application } from './Application.js';

export function useBuiltinPlugins(
  app: Application,
  agent: AgentRuntime,
  sessionController: SessionController,
): Application {
  return app
    .use(new BuiltInCommandsPlugin(agent, sessionController))
    .use(new MessageQueuePlugin())
    .use(new McpPlugin());
}
