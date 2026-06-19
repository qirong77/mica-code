import { micaUi } from '@packages/mica-ui/index.js';
import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import { AgentAbortError, type AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { MessageQueue } from './MessageQueue.js';
import { ToolLogController } from './ToolLogController.js';
import { reportRuntimeError } from './uiBridge.js';

export class TurnLoop {
  private responseBuffer = '';

  constructor(
    private readonly agent: AgentRuntime,
    private readonly sessionController: SessionController,
    private readonly queue: MessageQueue,
    private readonly toolLogs: ToolLogController,
  ) {}

  get isRunning() {
    return this.queue.isRunning;
  }

  clear() {
    this.responseBuffer = '';
    this.queue.clear();
    this.toolLogs.resetAll();
  }

  appendResponseText(text: string) {
    this.toolLogs.endThinkingSegment();
    this.responseBuffer += text;
    micaUi.conversation.setResponseText(this.responseBuffer);
  }

  async submit(rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    micaLogger.logRuntime('runtime', 'submit', { chars: text.length, running: this.queue.isRunning });

    if (this.queue.isRunning) {
      this.queue.enqueue(text);
      return;
    }

    await this.runTurn(text);
    while (true) {
      const next = this.queue.takePending();
      if (!next) break;
      await this.runTurn(next);
    }
  }

  private async runTurn(text: string) {
    this.queue.startRun();
    const startedAt = Date.now();
    const content = micaUi.parseImageRefs(text) as AgentQueryContent;
    let runId: number | null = null;
    let hasError = false;

    micaLogger.logRuntime('runtime', 'turn:start', { chars: text.length });
    this.responseBuffer = '';
    this.toolLogs.resetTurn();
    micaUi.terminalInput.clearText();
    micaUi.conversation.appendUserMessage(content);
    micaUi.conversation.clearResponseText();
    micaUi.panels.clearLogEntries();
    micaUi.panels.status.connecting();

    try {
      const result = await this.agent.run(content);
      runId = result.runId;
      const finalText = result.text;
      if (!this.agent.isCurrent(runId)) return;
      micaUi.conversation.appendAssistantMessage([
        { type: 'text', text: finalText || this.responseBuffer || '(empty response)' },
      ]);
      micaUi.conversation.clearResponseText();
      this.sessionController.saveCurrent();
      micaLogger.logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || this.responseBuffer).length });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        runId = error.runId;
        this.agent.preserveAbortedTurn(content, this.responseBuffer);
        this.sessionController.saveCurrent();
        micaLogger.logRuntime('runtime', 'turn:aborted_saved', { runId, chars: this.responseBuffer.length }, 'warn');
        return;
      }
      hasError = true;
      reportRuntimeError(error, '请求失败');
    } finally {
      const ownsCurrentTurn = runId == null || this.agent.isCurrent(runId);
      if (ownsCurrentTurn) {
        this.toolLogs.endThinkingSegment();
        if (!hasError) micaUi.panels.clearAgentTurnLogItems();
        this.queue.finishRun();
      }
      micaLogger.logRuntime('runtime', 'turn:finish', { elapsedMs: Date.now() - startedAt, hasError });
    }
  }
}
