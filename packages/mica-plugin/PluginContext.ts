import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { RuntimeEventBus } from '@packages/mica-runtime/index.js';
import type { HookRegistry } from './HookRegistry.js';
import type { ServiceContainer } from './ServiceContainer.js';

export type PluginContext = {
  pluginId: string;
  services: ServiceContainer;
  hooks: HookRegistry;
  commands: CommandRegistry;
  events: RuntimeEventBus;
  logger: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
    error(event: string, data?: unknown): void;
  };
  onDispose(dispose: () => void | Promise<void>): void;
};
