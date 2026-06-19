import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createForkCommand(services: CommandRuntimeServices) {
  return {
    name: 'fork',
    description: '从当前 agent 历史分叉一个新 agent',
    action: () => {
      const forked = services.forkCurrentAgent();
      services.switchAgentSession(forked.id);
      const mode = forked.sourceWasRunning ? 'before current turn' : 'full history';
      const message = `Forked agent #${forked.index} (${mode})`;
      micaLogger.logRuntime('plugin.fork', 'created', {
        id: forked.id,
        index: forked.index,
        sourceWasRunning: forked.sourceWasRunning,
      });
      services.showMessage(message, 5000);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
