import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export function createCompactCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'compact',
    description: '压缩当前会话上下文为 checkpoint',
    action: async () => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before compacting');
        return;
      }
      micaLogger.logRuntime('plugin.compact', 'requested');
      const ownerSessionId = services.getCurrentAgentSessionId();
      try {
        const result = await services.runExclusiveTask(
          targetAgent,
          { ownerSessionId, statusText: 'compact: summarizing context' },
          () => services.compact(targetAgent, sessionController, ownerSessionId),
        );
        services.showMessage(
          `Compact: ${result.beforeCount} -> ${result.afterCount} messages, tokens ${result.beforeTokenEstimate} -> ${result.afterTokenEstimate}`,
          6000,
          ownerSessionId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        micaLogger.logRuntime('plugin.compact', 'error', { message }, 'error');
        services.showMessage(`Compact failed: ${message}`, 6000, ownerSessionId);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
