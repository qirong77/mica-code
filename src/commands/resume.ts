import { micaUI } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { isAgentRunning, showMessage, syncModelDisplay } from '../app/bootstrap.js';
import type { SessionController } from '../session/SessionController.js';
import { showSelectCommand } from './selectCommand.js';
import { logRuntime } from '@packages/mica-logger/index.js';

export function registerResumePlugin(agent: AgentRuntime, sessionController: SessionController) {
  return {
    name: 'resume',
    description: '恢复之前的会话',
    action: (arg) => {
      if (isAgentRunning()) {
        logRuntime('plugin.resume', 'blocked:agent_running', undefined, 'warn');
        showMessage('Agent is running; wait or abort before resuming');
        return;
      }

      const id = arg?.trim();
      if (id) {
        logRuntime('plugin.resume', 'resume_by_id', { id });
        resumeSession(agent, sessionController, id);
        return;
      }

      logRuntime('plugin.resume', 'opened');
      showResumeSelector(agent, sessionController);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function showResumeSelector(agent: AgentRuntime, sessionController: SessionController) {
  const sessions = sessionController.list(20);
  logRuntime('plugin.resume', 'selector:ready', { sessions: sessions.length });
  showSelectCommand({
    id: 'select-session',
    title: 'resume session',
    current: '',
    options: sessions.map((session) => ({
      name: session.id,
      label: `${session.title}  ${formatSessionMeta(session.updatedAt, session.model)}`,
    })),
    emptyMessage: 'no saved sessions',
    onSelect: (id) => resumeSession(agent, sessionController, id),
  });
}

function resumeSession(agent: AgentRuntime, sessionController: SessionController, id: string) {
  logRuntime('plugin.resume', 'resume:start', { id });
  const result = sessionController.resume(id);
  if (result.ok === false) {
    logRuntime('plugin.resume', 'resume:error', { id, message: result.message }, 'error');
    showMessage(result.message, 5000);
    return;
  }
  syncModelDisplay(agent);
  showMessage(`Resumed: ${result.session.title}`, 4000);
  logRuntime('plugin.resume', 'resume:done', {
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
