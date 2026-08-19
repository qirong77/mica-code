import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandRuntimeServices, CommandSessionController } from '../services.js';

export function createRenameCommand(
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
): BuiltInCommandItem {
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
