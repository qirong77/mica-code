
import type { CommandRuntimeServices, RunningAgentRecord } from './services.js';

export function submitAgentPromptInBackground({
  namespace,
  services,
  session,
  prompt,
  startedMessage,
}: {
  namespace: 'plugin.new' | 'plugin.fork';
  services: CommandRuntimeServices;
  session: RunningAgentRecord;
  prompt: string;
  startedMessage: string;
}): void {
  services.showMessage(startedMessage, 4000);

  const reportError = (reason: string) => {
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
