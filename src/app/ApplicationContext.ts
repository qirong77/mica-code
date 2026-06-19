import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { HookRegistry, PluginManager, ServiceContainer } from '@packages/mica-plugin/index.js';
import type { RuntimeEventBus } from '@packages/mica-runtime/index.js';
import type { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import type { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';
import type { AgentRegistry } from '../agents/agentRegistry.js';

export type ApplicationContext = {
  agent: AgentRuntime;
  sessionController: SessionController;
  commands: CommandRegistry;
  hooks: HookRegistry;
  services: ServiceContainer;
  events: RuntimeEventBus;
  plugins: PluginManager;
  runtime: LocalRuntimeController;
  uiBridge: MicaUiRuntimeBridge;
  agentRegistry: AgentRegistry;
};
