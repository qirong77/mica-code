import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import type { CommandSessionController } from './services.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createResumeCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'resume',
    description: '恢复之前的会话',
    action: (arg) => {
      if (services.isAgentBusy(agent)) {
        micaLogger.logRuntime('plugin.resume', 'blocked:agent_busy', undefined, 'warn');
        services.showMessage('Agent is busy; wait or abort before resuming');
        return;
      }

      const id = arg?.trim();
      if (id) {
        micaLogger.logRuntime('plugin.resume', 'resume_by_id', { id });
        resumeSession(agent, sessionController, services, id);
        return;
      }

      micaLogger.logRuntime('plugin.resume', 'opened');
      showResumeSelector(agent, sessionController, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showResumeSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  const sessions = sessionController.list(20);
  micaLogger.logRuntime('plugin.resume', 'selector:ready', { sessions: sessions.length });
  showSelectCommand({
    id: 'select-session',
    title: 'resume session',
    current: '',
    options: sessions.map((session) => ({
      name: session.id,
      label: `${session.title}  ${formatSessionMeta(session.updatedAt, session.model)}`,
    })),
    emptyMessage: 'no saved sessions',
    onSelect: (id) => resumeSession(agent, sessionController, services, id),
  });
}

function resumeSession(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  id: string,
) {
  micaLogger.logRuntime('plugin.resume', 'resume:start', { id });
  const result = sessionController.resume(id);
  if (result.ok === false) {
    micaLogger.logRuntime('plugin.resume', 'resume:error', { id, message: result.message }, 'error');
    services.showMessage(result.message, 5000);
    return;
  }
  services.syncModelDisplay(agent);
  services.refreshCurrentAgentSessionUi();
  services.showMessage(`Resumed: ${result.session.title}`, 4000);
  micaLogger.logRuntime('plugin.resume', 'resume:done', {
    id,
    title: result.session.title,
    model: result.session.snapshot.model,
  });
}

function formatSessionMeta(updatedAt: string, model: string): string {
  const date = new Date(updatedAt);
  const timestamp = Number.isNaN(date.getTime())
    ? updatedAt
    : date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
  return `[${timestamp} ${model}]`;
}
