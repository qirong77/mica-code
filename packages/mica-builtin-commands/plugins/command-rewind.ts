import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createRewindCommand } from '../commands/rewind.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandRewind(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('rewind requires the builtin command host');
  host.registerCommand(ctx, createRewindCommand(host.services));
}
