import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandSessionController, CommandRuntimeServices } from './services.js';
import { micaLogger } from '@packages/mica-logger/index.js';

export function createRenameCommand(sessionController: CommandSessionController, services: CommandRuntimeServices) {
  return {
    name: 'rename',
    description: '重命名当前会话',
    action: async (args?: string) => {
      const title = args?.trim();
      if (!title) {
        services.showMessage('Usage: /rename <new title>');
        return;
      }
      sessionController.renameCurrent(title);
      services.renameCurrentAgentSession(title);
      micaLogger.logRuntime('plugin.rename', 'renamed', { title });
      services.showMessage(`Session renamed to: ${title}`);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
