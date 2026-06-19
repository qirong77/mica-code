import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { BuiltInCommandsPlugin } from '../plugins/commands/index.js';
import { McpPlugin } from '../plugins/mcp/index.js';
import { MessageQueuePlugin } from '../plugins/runtime/index.js';
import { IpcServerPlugin } from '../plugins/ipc/index.js';
import type { Application } from './Application.js';
import type { AgentRegistry } from '../agents/agentRegistry.js';
import type { LocalRuntimeController } from './adapters/LocalRuntimeController.js';

export function useBuiltinPlugins(
  app: Application,
  agent: AgentRuntime,
  sessionController: SessionController,
  agentRegistry: AgentRegistry,
  runtime: LocalRuntimeController,
): Application {
  return app
    .use(new BuiltInCommandsPlugin(agent, sessionController))
    .use(new MessageQueuePlugin())
    .use(new IpcServerPlugin(agentRegistry, runtime))
    .use(new McpPlugin());
}
