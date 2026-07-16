import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandFork(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createForkCommand(host.services), { allowDuringTurn: true });
}

export function createForkCommand(services) {
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
        });
        return;
      }
      services.switchAgentSession(forked.id);
      const mode = forked.sourceWasRunning ? 'before current turn' : 'full history';
      services.showMessage(`Forked agent #${forked.index} (${mode})`, 5000);
    },
  };
}

function submitAgentPromptInBackground({ services, session, prompt, startedMessage }) {
  services.showMessage(startedMessage, 4000);
  const reportError = (reason) => {
    services.showMessage(`Agent #${session.index} failed to start: ${reason}`, 6000);
  };

  void services
    .submitAgentSessionInput(session.id, prompt)
    .then((result) => {
      if (result.ok) return;
      reportError(result.error instanceof Error ? result.error.message : result.reason);
    })
    .catch((error) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
}
