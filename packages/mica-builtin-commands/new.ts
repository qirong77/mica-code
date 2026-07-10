import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from './services.js';
import { submitAgentPromptInBackground } from './agentBackground.js';

export function createNewCommand(services: CommandRuntimeServices) {
  return {
    name: 'new',
    description: '新开一个 agent；/new <text> 后台运行新 agent',
    action: (arg?: string) => {
      const session = services.newAgentSession();
      const prompt = arg?.trim();
      if (prompt) {
        submitAgentPromptInBackground({
          services,
          session,
          prompt,
          startedMessage: `Started agent #${session.index} in background`,
        });
        return;
      }
      services.switchAgentSession(session.id);
      const message = `Created agent #${session.index}`;
      services.showMessage(message, 4000);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
