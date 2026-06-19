import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createNewCommand(services: CommandRuntimeServices) {
  return {
    name: 'new',
    description: '新开一个 agent 会话',
    action: () => {
      const session = services.newAgentSession();
      services.switchAgentSession(session.id);
      const message = `Created agent #${session.index}`;
      micaLogger.logRuntime('plugin.new', 'created', { id: session.id, index: session.index });
      services.showMessage(message, 4000);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
