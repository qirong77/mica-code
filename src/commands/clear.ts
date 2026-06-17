import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { clearUI, showMessage } from '../app/bootstrap.js';
import { logRuntime } from '../logger.js';

export function registerClearPlugin(agent: AgentRuntime, sessionController: SessionController) {
  return {
    name: 'clear',
    description: '清空当前对话和运行状态',
    action: () => {
      logRuntime('plugin.clear', 'clear:start', {
        runId: agent.currentRunId,
      });
      clearUI(agent, sessionController);
      showMessage('Session cleared');
      logRuntime('plugin.clear', 'clear:done');
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
