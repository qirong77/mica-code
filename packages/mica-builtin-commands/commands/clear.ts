import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

export function createClearCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  onCleared: () => void,
): BuiltInCommandItem {
  return {
    name: 'clear',
    description: '新开一个空 session，不清除当前 session 内容',
    action() {
      if (services.isAgentBusy(agent)) {
        services.showNotice('Agent is busy; wait or abort before starting a new session', undefined, {
          command: '/clear',
          status: 'warning',
        });
        return;
      }
      services.clearSubagentTasks?.(agent);
      services.clearUI(agent, sessionController);
      onCleared();
      services.showNotice('Started new session', undefined, { command: '/clear', status: 'success' });
    },
  };
}
