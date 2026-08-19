import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createCdCommand } from '../commands/cd.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandCd(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('cd requires the builtin command host');
  host.registerCommand(ctx, createCdCommand(host.sessionController, host.services));
}
