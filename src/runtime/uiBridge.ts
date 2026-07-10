import { micaUi } from '@packages/mica-ui/index.js';
import type { AgentRuntime, AgentRuntimeStatus } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';

export function reportRuntimeError(error: unknown, title = '运行错误') {
  const message = error instanceof Error ? error.message : String(error);
  micaUi.conversation.clearResponseText();
  micaUi.panels.thinkingText.set('');
  micaUi.panels.status.error();
  micaUi.messageBar.addMessage({ id: `error-${Date.now()}`, text: `${title}: ${message}` });
}

export function resetActiveTurnUI() {
  micaUi.conversation.clearResponseText();
  micaUi.conversation.clearPendingInput();
  micaUi.panels.thinkingText.set('');
  micaUi.panels.clearAgentTurnLogItems();
  micaUi.panels.clearPluginUIs();
  micaUi.messageBar.clearMessages();
  micaUi.panels.status.idle();
  micaUi.terminalInput.clearText();
}

export function syncModelDisplay(agent: AgentRuntime) {
  micaUi.panels.modelDisplay.name.set(agent.config.model);
  micaUi.panels.modelDisplay.effort.set(agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none');
  micaUi.panels.modelDisplay.contextWindowSize.set(agent.config.provider.contextWindowSize);
}

export function clearUI(agent: AgentRuntime, sessionController?: SessionController) {
  agent.clearSession();
  sessionController?.startNewSession();
  micaUi.conversation.clearMessages();
  micaUi.conversation.clearResponseText();
  micaUi.conversation.clearPendingInput();
  micaUi.panels.thinkingText.set('');
  micaUi.panels.clearAgentTurnLogItems();
  micaUi.panels.clearPluginUIs();
  micaUi.panels.clearCommandPanelItems();
  micaUi.messageBar.clearMessages();
  micaUi.panels.contextSize.set(0);
  micaUi.panels.cachedTokenRate.set(0);
  micaUi.panels.status.idle();
  micaUi.terminalInput.clearText();
}

export function applyStatus(status: AgentRuntimeStatus) {
  switch (status.type) {
    case 'idle':
      micaUi.panels.status.idle();
      break;
    case 'connecting':
      micaUi.panels.status.connecting(status.startedAt, status.moduleStartedAt);
      break;
    case 'thinking':
      micaUi.panels.status.thinking(status.startedAt, status.moduleStartedAt);
      break;
    case 'streaming':
      micaUi.panels.status.streaming(status.startedAt, status.moduleStartedAt);
      break;
    case 'calling_tool':
      micaUi.panels.status.callingTool(status.toolNames, undefined, status.startedAt, status.moduleStartedAt);
      break;
    case 'completed':
      micaUi.panels.status.completed(status.elapsedMs, status.startedAt);
      break;
    case 'error':
      micaUi.panels.status.error();
      break;
  }
}

export function showMessage(text: string, ttl = 3000) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUi.messageBar.addMessage({ id, text });
  setTimeout(() => micaUi.messageBar.removeMessage(id), ttl);
}
