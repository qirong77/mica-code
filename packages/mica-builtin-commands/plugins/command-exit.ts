import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createExitCommand } from '../commands/exit.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandExit(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('exit requires the builtin command host');
  host.registerCommand(ctx, createExitCommand(host.services), { allowDuringTurn: true });
}
