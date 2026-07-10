
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

type RecapArgs = {
  customInstructions?: string;
};

export function createRecapCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'recap',
    description: '生成并保存一条会话回顾',
    completionItems: [
      { arg: '聚焦当前任务和下一步', label: 'focus next step' },
      { arg: '只总结最近的报错和验证结果', label: 'focus errors' },
    ],
    action: async (rawArgs?: string) => {
      const ownerSessionId = services.getCurrentAgentSessionId();
      const targetAgent = services.getCurrentAgent() ?? agent;
      const args = parseRecapArgs(rawArgs);

      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('recap: agent is busy; wait or abort first', 5000, ownerSessionId);
        return;
      }

      try {
        const result = await services.runExclusiveTask(
          targetAgent,
          { ownerSessionId, statusText: 'recap: summarizing context' },
          () => services.recap(targetAgent, ownerSessionId, args),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        services.showMessage(`recap failed: ${message}`, 8000, ownerSessionId);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function parseRecapArgs(rawArgs?: string): RecapArgs {
  const customInstructions = (rawArgs ?? '').trim();
  return customInstructions ? { customInstructions } : {};
}
