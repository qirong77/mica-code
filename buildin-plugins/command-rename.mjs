import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandRename(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createRenameCommand(host.sessionController, host.services), { allowDuringTurn: true });
}

export function createRenameCommand(sessionController, services) {
  return {
    name: 'rename',
    description: '重命名当前会话',
    action(args) {
      const title = args?.trim();
      if (!title) {
        services.showNotice('Usage: /rename <new title>', undefined, { command: '/rename', status: 'info' });
        return;
      }
      sessionController.renameCurrent(title);
      services.renameCurrentAgentSession(title);
      services.showNotice(`Session renamed to: ${title}`, undefined, { command: '/rename', status: 'success' });
    },
  };
}
