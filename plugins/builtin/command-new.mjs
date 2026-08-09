import { commandHostToken } from '../../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandNew(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createNewCommand(host.services), { allowDuringTurn: true });
}

export function createNewCommand(services) {
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
        });
        return;
      }
      services.switchAgentSession(session.id);
      services.showNotice(`Created agent #${session.index}`, undefined, { command: '/new', status: 'success' });
    },
  };
}

function submitAgentPromptInBackground({ services, session, prompt, startedMessage }) {
  services.showNotice(startedMessage, undefined, { command: '/new', status: 'success' });
  const reportError = (reason) => {
    services.showNotice(`Agent #${session.index} failed to start: ${reason}`, undefined, {
      command: '/new',
      status: 'error',
    });
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
