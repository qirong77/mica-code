import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from '../services.js';
import { submitAgentPromptInBackground } from '../shared/agentBackground.js';

export function createForkCommand(services: CommandRuntimeServices) {
  return {
    name: 'fork',
    description: '从当前 agent 历史分叉一个新 agent；/fork <text> 后台运行',
    action: (arg?: string) => {
      const forked = services.forkCurrentAgent();
      const prompt = arg?.trim();
      if (prompt) {
        submitAgentPromptInBackground({
          services,
          session: forked,
          prompt,
          startedMessage: `Forked agent #${forked.index} in background`,
        });
        return;
      }
      services.switchAgentSession(forked.id);
      const mode = forked.sourceWasRunning ? 'before current turn' : 'full history';
      const message = `Forked agent #${forked.index} (${mode})`;
      services.showMessage(message, 5000);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
