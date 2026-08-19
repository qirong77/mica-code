import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createClearCommand } from '../commands/clear.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandClear(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('clear requires the builtin command host');
  host.registerCommand(
    ctx,
    createClearCommand(host.agent, host.sessionController, host.services, () => {
      ctx.events.publish({ type: 'session:cleared', owner: host.agent });
    }),
  );
}
