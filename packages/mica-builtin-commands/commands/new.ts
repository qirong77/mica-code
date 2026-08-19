import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandRuntimeServices, RunningAgentRecord } from '../services.js';
import type { SubmitResult } from '@packages/mica-runtime/index.js';

export function createNewCommand(services: CommandRuntimeServices): BuiltInCommandItem {
  return {
    name: 'new',
    description: '新开一个 agent；/new <text> 后台运行新 agent',
    action(arg) {
      const session = services.newAgentSession();
      const prompt = arg?.trim();
      if (prompt) {
        submitAgentPromptInBackground({
          services,
          session,
          prompt,
          startedMessage: `Started agent #${session.index} in background`,
          command: '/new',
        });
        return;
      }
      services.switchAgentSession(session.id);
      services.showNotice(`Created agent #${session.index}`, undefined, { command: '/new', status: 'success' });
    },
  };
}

function submitAgentPromptInBackground({
  services,
  session,
  prompt,
  startedMessage,
  command,
}: {
  services: CommandRuntimeServices;
  session: RunningAgentRecord;
  prompt: string;
  startedMessage: string;
  command: string;
}) {
  services.showNotice(startedMessage, undefined, { command, status: 'success' });
  const reportError = (reason: string) => {
    services.showNotice(`Agent #${session.index} failed to start: ${reason}`, undefined, {
      command,
      status: 'error',
    });
  };

  void services
    .submitAgentSessionInput(session.id, prompt)
    .then((result: SubmitResult) => {
      if (result.ok) return;
      reportError(result.error instanceof Error ? result.error.message : result.reason);
    })
    .catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
}
