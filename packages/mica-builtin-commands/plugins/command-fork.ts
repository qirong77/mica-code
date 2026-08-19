import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createForkCommand } from '../commands/fork.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandFork(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('fork requires the builtin command host');
  host.registerCommand(ctx, createForkCommand(host.services), { allowDuringTurn: true });
}
