import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createCompactCommand } from '../commands/compact.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandCompact(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('compact requires the builtin command host');
  host.registerCommand(ctx, createCompactCommand(host.agent, host.sessionController, host.services));
}
