import { micaUi } from '@packages/mica-ui/index.js';
import type { AgentChangeTracker, ChangeOwner } from './agentChangeTracker.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

export function createDiffCommand(agent: CommandAgent, services: CommandRuntimeServices, tracker: AgentChangeTracker) {
  return {
    name: 'diff',
    description: '显示当前 Git 变更文件及其来源',
    action: () => {
      const target = services.getCurrentAgent() ?? agent;
      try {
        const files = tracker.list(target.taskOwnerId);
        const text = files.length
          ? files
              .map((file) => `${file.status.padEnd(2)}  ${ownerLabel(file.owner).padEnd(10)}  ${file.path}`)
              .join('\n')
          : 'diff: 工作区没有变化';
        services.showNotice(text, services.getCurrentAgentSessionId(), {
          command: '/diff',
          status: 'info',
        });
      } catch (error) {
        services.showNotice(
          `diff failed: ${error instanceof Error ? error.message : String(error)}`,
          services.getCurrentAgentSessionId(),
          {
            command: '/diff',
            status: 'error',
          },
        );
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function ownerLabel(owner: ChangeOwner): string {
  if (owner === 'agent') return '当前 Agent';
  if (owner === 'mixed') return '混合';
  return '非当前 Agent';
}
