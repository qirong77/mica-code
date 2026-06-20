import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createForkCommand(services: CommandRuntimeServices) {
  return {
    name: 'fork',
    description: '从当前 agent 历史分叉一个新 agent；/fork <text> 后台运行',
    action: (arg?: string) => {
      const forked = services.forkCurrentAgent();
      const prompt = arg?.trim();
      if (prompt) {
        const message = `Forked agent #${forked.index} in background`;
        micaLogger.logRuntime('plugin.fork', 'background:start', {
          id: forked.id,
          index: forked.index,
          chars: prompt.length,
        });
        services.showMessage(message, 4000);
        void services
          .submitAgentSessionInput(forked.id, prompt)
          .then((result) => {
            if (result.ok) return;
            const reason = result.error instanceof Error ? result.error.message : result.reason;
            micaLogger.logRuntime(
              'plugin.fork',
              'background:error',
              { id: forked.id, index: forked.index, reason },
              'error',
            );
            services.showMessage(`Agent #${forked.index} failed to start: ${reason}`, 6000);
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            micaLogger.logRuntime(
              'plugin.fork',
              'background:error',
              { id: forked.id, index: forked.index, reason },
              'error',
            );
            services.showMessage(`Agent #${forked.index} failed to start: ${reason}`, 6000);
          });
        return;
      }
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
