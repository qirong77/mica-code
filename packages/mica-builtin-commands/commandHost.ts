import type { MicaCommandCompletionItems } from '@packages/mica-commands/index.js';
import { micaPlugin, type PluginContext, type ServiceToken } from '@packages/mica-plugin/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export type BuiltInCommandItem = {
  name: string;
  description?: string;
  completionItems?: MicaCommandCompletionItems;
  action(args?: string): unknown | Promise<unknown>;
};

export type CommandHostService = {
  agent: CommandAgent;
  sessionController: CommandSessionController;
  services: CommandRuntimeServices;
  registerCommand(ctx: PluginContext, command: BuiltInCommandItem, options?: { allowDuringTurn?: boolean }): void;
};

export const commandHostToken: ServiceToken<CommandHostService> =
  micaPlugin.createServiceToken<CommandHostService>('builtin.command-host');
