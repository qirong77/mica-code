import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandExit(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createExitCommand(host.services), { allowDuringTurn: true });
}

export function createExitCommand(services) {
  return {
    name: 'exit',
    description: '退出程序',
    async action() {
      await services.requestExit(0);
    },
  };
}
