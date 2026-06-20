import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createNewCommand(services: CommandRuntimeServices) {
  return {
    name: 'new',
    description: '新开一个 agent；/new <text> 后台运行新 agent',
    action: (arg?: string) => {
      const session = services.newAgentSession();
      const prompt = arg?.trim();
      if (prompt) {
        const message = `Started agent #${session.index} in background`;
        micaLogger.logRuntime('plugin.new', 'background:start', {
          id: session.id,
          index: session.index,
          chars: prompt.length,
        });
        services.showMessage(message, 4000);
        void services
          .submitAgentSessionInput(session.id, prompt)
          .then((result) => {
            if (result.ok) return;
            const reason = result.error instanceof Error ? result.error.message : result.reason;
            micaLogger.logRuntime(
              'plugin.new',
              'background:error',
              { id: session.id, index: session.index, reason },
              'error',
            );
            services.showMessage(`Agent #${session.index} failed to start: ${reason}`, 6000);
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            micaLogger.logRuntime(
              'plugin.new',
              'background:error',
              { id: session.id, index: session.index, reason },
              'error',
            );
            services.showMessage(`Agent #${session.index} failed to start: ${reason}`, 6000);
          });
        return;
      }
      services.switchAgentSession(session.id);
      const message = `Created agent #${session.index}`;
      micaLogger.logRuntime('plugin.new', 'created', { id: session.id, index: session.index });
      services.showMessage(message, 4000);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
