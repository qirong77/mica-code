import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createRenameCommand } from '../commands/rename.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandRename(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('rename requires the builtin command host');
  host.registerCommand(ctx, createRenameCommand(host.sessionController, host.services), { allowDuringTurn: true });
}
