import { micaUI } from '@packages/mica-ui/index.js';
import { micaAgent } from '@packages/mica-agent/index.js';
import type { AgentRuntime, AgentRuntimeStatus } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { clearRuntimeLogs, logRuntime } from '@packages/mica-logger/index.js';

export function reportRuntimeError(error: unknown, title = '运行错误') {
  const message = error instanceof Error ? error.message : String(error);
  logRuntime('runtime', 'error', { title, message }, 'error');
  micaUI.conversation.clearResponseText();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.status.error(message);
  micaUI.panels.setAgentTurnLogItems([
    micaAgent.createErrorLogItem({
      id: `error-${Date.now()}`,
      title,
      error,
    }),
  ]);
}

export function resetActiveTurnUI() {
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.clearLogEntries();
  micaUI.panels.clearLog();
  clearRuntimeLogs();
  micaUI.panels.clearPluginUIs();
  micaUI.messageBar.clearMessages();
  micaUI.panels.status.idle();
  micaUI.terminalInput.clearText();
}

export function syncModelDisplay(agent: AgentRuntime) {
  micaUI.panels.modelDisplay.name.set(agent.config.model);
  micaUI.panels.modelDisplay.effort.set(agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none');
  micaUI.panels.modelDisplay.contextWindowSize.set(agent.config.provider.contextWindowSize);
  logRuntime('runtime', 'model:display_synced', {
    model: agent.config.model,
    effort: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
  });
}

export function clearUI(agent: AgentRuntime, sessionController?: SessionController) {
  logRuntime('runtime', 'ui:clear');
  agent.clearSession();
  sessionController?.startNewSession();
  micaUI.conversation.clearMessages();
  micaUI.conversation.clearResponseText();
  micaUI.conversation.clearPendingInput();
  micaUI.panels.thinkingText.set('');
  micaUI.panels.clearLogEntries();
  micaUI.panels.clearLog();
  clearRuntimeLogs();
  micaUI.panels.clearPluginUIs();
  micaUI.messageBar.clearMessages();
  micaUI.panels.contextSize.set(0);
  micaUI.panels.cachedTokenRate.set(0);
  micaUI.panels.status.idle();
  micaUI.terminalInput.clearText();
}

export function applyStatus(status: AgentRuntimeStatus) {
  switch (status.type) {
    case 'idle':
      micaUI.panels.status.idle();
      break;
    case 'connecting':
      micaUI.panels.status.connecting();
      break;
    case 'thinking':
      micaUI.panels.status.thinking();
      break;
    case 'streaming':
      micaUI.panels.status.streaming();
      break;
    case 'calling_tool':
      micaUI.panels.status.callingTool(status.toolNames);
      break;
    case 'completed':
      micaUI.panels.status.completed(status.elapsedMs);
      break;
    case 'error':
      micaUI.panels.status.error(status.message);
      break;
  }
}

export function showMessage(text: string, ttl = 3000) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), ttl);
}
