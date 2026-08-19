import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandRuntimeServices, ForkAgentResult } from '../services.js';
import type { SubmitResult } from '@packages/mica-runtime/index.js';

export function createForkCommand(services: CommandRuntimeServices): BuiltInCommandItem {
  return {
    name: 'fork',
    description: '从当前 agent 历史分叉一个新 agent；/fork <text> 后台运行',
    action(arg) {
      const forked = services.forkCurrentAgent();
      const prompt = arg?.trim();
      if (prompt) {
        submitAgentPromptInBackground({
          services,
          session: forked,
          prompt,
          startedMessage: `Forked agent #${forked.index} in background`,
          command: '/fork',
        });
        return;
      }
      services.switchAgentSession(forked.id);
      const mode = forked.sourceWasRunning ? 'before current turn' : 'full history';
      services.showNotice(`Forked agent #${forked.index} (${mode})`, undefined, {
        command: '/fork',
        status: 'success',
      });
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
  session: ForkAgentResult;
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
