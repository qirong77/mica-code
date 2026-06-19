import { micaUI } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '@packages/mica-logger/index.js';
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
    const cachedTokenRate = readTotalCachedTokenRate(agent);
    micaUI.panels.contextSize.set(usage.totalTokens);
    micaUI.panels.cachedTokenRate.set(cachedTokenRate);
    logRuntime('runtime', 'usage:displayed', {
      context: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cachedTokenRate,
      paidTokenRate: usage.paidTokenRate,
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

function readCachedTokenRate(usage: { inputTokens: number; cachedInputTokens?: number }): number {
  if (usage.inputTokens <= 0) return 0;
  return Math.max(0, (usage.cachedInputTokens ?? 0) / usage.inputTokens);
}

function readTotalCachedTokenRate(agent: AgentRuntime): number {
  const snapshot = agent.getSnapshot();
  const totalInput = snapshot.usageHistory.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalCached = snapshot.usageHistory.reduce((sum, u) => sum + (u.cachedInputTokens ?? 0), 0);
  if (totalInput <= 0) return 0;
  return Math.max(0, totalCached / totalInput);
}
