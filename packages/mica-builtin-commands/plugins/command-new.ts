import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createNewCommand } from '../commands/new.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandNew(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('new requires the builtin command host');
  host.registerCommand(ctx, createNewCommand(host.services), { allowDuringTurn: true });
}
