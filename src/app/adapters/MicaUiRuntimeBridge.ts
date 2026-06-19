import { micaAgent } from '@packages/mica-agent/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import { ToolLogController } from '../../runtime/ToolLogController.js';
import { applyStatus, resetActiveTurnUI, showMessage, syncModelDisplay } from '../../runtime/uiBridge.js';
import type { LocalRuntimeController } from './LocalRuntimeController.js';
import type { RuntimeController } from '@packages/mica-runtime/index.js';

export class MicaUiRuntimeBridge {
  private readonly toolLogs = new ToolLogController();
  private activeController: RuntimeController;

  constructor(
    private readonly agent: AgentRuntime,
    private readonly runtime: LocalRuntimeController,
  ) {
    this.activeController = runtime;
  }

  setActiveController(controller: RuntimeController): void {
    this.activeController = controller;
  }

  resetActiveController(): void {
    this.activeController = this.runtime;
  }

  async detachActiveController(): Promise<void> {
    if (this.activeController === this.runtime) return;
    await this.activeController.stop();
    this.activeController = this.runtime;
  }

  start(): void {
    syncModelDisplay(this.agent);
    micaLogger.logRuntime('runtime', 'ui_bridge:start');

    this.agent.events.on('status', applyStatus);
    this.agent.events.on('text', (text) => {
      this.toolLogs.endThinkingSegment();
      micaUi.conversation.setResponseText(this.runtime.appendResponseText(text));
    });
    this.agent.events.on('thinking', (text) => this.toolLogs.appendThinking(text));
    this.agent.events.on('toolCall', (toolCall) => this.toolLogs.addToolCall(toolCall));
    this.agent.events.on('toolResult', (toolResult) => this.toolLogs.completeToolCall(toolResult));
    this.agent.events.on('usage', (usage) => {
      const cachedTokenRate = readTotalCachedTokenRate(this.agent);
      micaUi.panels.contextSize.set(usage.totalTokens);
      micaUi.panels.cachedTokenRate.set(cachedTokenRate);
      micaLogger.logRuntime('runtime', 'usage:displayed', {
        context: usage.totalTokens,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        cachedTokenRate,
        paidTokenRate: usage.paidTokenRate,
      });
    });

    this.runtime.events.on('event', (event) => {
      if (event.type === 'queue:changed') {
        micaUi.conversation.setPendingInputs(event.pendingInputs.map((input) => input.text));
      }
      if (event.type === 'notification') {
        showMessage(event.message);
      }
      if (event.type === 'turn:started') {
        this.toolLogs.resetTurn();
        micaUi.panels.clearLogEntries();
      }
      if (event.type === 'turn:finished') {
        this.toolLogs.endThinkingSegment();
      }
    });

    micaUi.terminalInput.onSubmit((text) => {
      void this.activeController.submit(text);
    });

    micaUi.panels.setOnAbortAgent(() => {
      void this.activeController.abort();
      resetActiveTurnUI();
      this.toolLogs.resetTurn();
    });
  }

  clearToolLogs(): void {
    this.toolLogs.resetAll();
  }
}

function readTotalCachedTokenRate(agent: AgentRuntime): number {
  const snapshot = agent.getSnapshot();
  const totalInput = snapshot.usageHistory.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalCached = snapshot.usageHistory.reduce((sum, u) => sum + (u.cachedInputTokens ?? 0), 0);
  if (totalInput <= 0) return 0;
  return Math.max(0, totalCached / totalInput);
}
