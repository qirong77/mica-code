import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from '../services.js';
import type { CommandSessionController } from '../services.js';
import type { CommandRuntimeServices } from '../services.js';

export function createClearCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'clear',
    description: '新开一个空 session，不清除当前 session 内容',
    action: () => {
      if (services.isAgentBusy(agent)) {
        services.showMessage('Agent is busy; wait or abort before starting a new session');
        return;
      }
      services.clearUI(agent, sessionController);
      services.showMessage('Started new session');
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
