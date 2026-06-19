import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import type { CommandSessionController } from './services.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createClearCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'clear',
    description: '清空当前对话和运行状态',
    action: () => {
      micaLogger.logRuntime('plugin.clear', 'clear:start', {
        runId: agent.currentRunId,
      });
      services.clearUI(agent, sessionController);
      services.showMessage('Session cleared');
      micaLogger.logRuntime('plugin.clear', 'clear:done');
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
