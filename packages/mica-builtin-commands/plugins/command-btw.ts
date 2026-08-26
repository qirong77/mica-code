import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createBtwCommand } from '../commands/btw.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';

export default function setupCommandBtw(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('btw requires the builtin command host');
  // allowDuringTurn：即使主流程正在运行也可以立即旁路提问，不阻塞主流程。
  host.registerCommand(ctx, createBtwCommand(host.agent, host.services), { allowDuringTurn: true });
}
