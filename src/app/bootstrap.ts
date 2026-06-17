import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../logger.js';
import { MessageQueue } from '../runtime/MessageQueue.js';
import { ToolLogController } from '../runtime/ToolLogController.js';
import { TurnLoop } from '../runtime/TurnLoop.js';
import {
  applyStatus,
  clearUI as clearUiState,
  reportRuntimeError,
  resetActiveTurnUI,
  showMessage,
  syncModelDisplay,
} from '../runtime/uiBridge.js';

type BootstrapOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  onConfigChanged: () => void;
};

let activeLoop: TurnLoop | null = null;
let activeQueue: MessageQueue | null = null;
let activeToolLogs: ToolLogController | null = null;

export function bootstrap({ agent, sessionController, onConfigChanged }: BootstrapOptions) {
  const queue = new MessageQueue();
  const toolLogs = new ToolLogController();
  const turnLoop = new TurnLoop(agent, sessionController, queue, toolLogs);

  activeQueue = queue;
  activeToolLogs = toolLogs;
  activeLoop = turnLoop;

  syncModelDisplay(agent);
  logRuntime('runtime', 'bootstrap');

  agent.events.on('status', applyStatus);
  agent.events.on('text', (text) => turnLoop.appendResponseText(text));
  agent.events.on('thinking', (text) => toolLogs.appendThinking(text));
  agent.events.on('toolCall', (toolCall) => toolLogs.addToolCall(toolCall));
  agent.events.on('toolResult', (toolResult) => toolLogs.completeToolCall(toolResult));
  agent.events.on('usage', (usage) => {
    micaUI.panels.contextSize.set(usage.totalTokens);
    micaUI.panels.cacheHitRate.set(usage.cacheHitRate);
    logRuntime('runtime', 'usage:displayed', {
      context: usage.totalTokens,
      cacheHitRate: usage.cacheHitRate,
    });
  });

  micaUI.terminalInput.onSubmit((text) => {
    void turnLoop.submit(text);
  });

  micaUI.panels.setOnAbortAgent(() => {
    if (!queue.isRunning) return;
    logRuntime('runtime', 'abort:requested', undefined, 'warn');
    agent.abort();
    queue.finishRun();
    resetActiveTurnUI();
    toolLogs.resetTurn();
  });

  onConfigChanged();
}

export function clearUI(agent: AgentRuntime, sessionController?: SessionController) {
  activeLoop?.clear();
  clearUiState(agent, sessionController);
}

export function isAgentRunning() {
  return activeQueue?.isRunning ?? false;
}

export { reportRuntimeError, showMessage, syncModelDisplay };
