import { micaUI, parseImageRefs } from '../../packages/mica-ui/index.js';
import type { AgentQueryContent } from '../../packages/agent/core/Agent.js';
import { AgentAbortError, type AgentRuntime } from '../agent/AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../logger.js';
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
    micaUI.conversation.setResponseText(this.responseBuffer);
  }

  async submit(rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    logRuntime('runtime', 'submit', { chars: text.length, running: this.queue.isRunning });

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
    const content = parseImageRefs(text) as AgentQueryContent;
    let runId: number | null = null;
    let hasError = false;

    logRuntime('runtime', 'turn:start', { chars: text.length });
    this.responseBuffer = '';
    this.toolLogs.resetTurn();
    micaUI.terminalInput.clearText();
    micaUI.conversation.appendUserMessage(content);
    micaUI.conversation.clearResponseText();
    micaUI.panels.clearLogEntries();
    micaUI.panels.status.connecting();

    try {
      const result = await this.agent.run(content);
      runId = result.runId;
      const finalText = result.text;
      if (!this.agent.isCurrent(runId)) return;
      micaUI.conversation.appendAssistantMessage([
        { type: 'text', text: finalText || this.responseBuffer || '(empty response)' },
      ]);
      micaUI.conversation.clearResponseText();
      this.sessionController.saveCurrent();
      logRuntime('runtime', 'turn:saved', { runId, chars: (finalText || this.responseBuffer).length });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        runId = error.runId;
        this.agent.preserveAbortedTurn(content, this.responseBuffer);
        this.sessionController.saveCurrent();
        logRuntime('runtime', 'turn:aborted_saved', { runId, chars: this.responseBuffer.length }, 'warn');
        return;
      }
      hasError = true;
      reportRuntimeError(error, '请求失败');
    } finally {
      const ownsCurrentTurn = runId == null || this.agent.isCurrent(runId);
      if (ownsCurrentTurn) {
        this.toolLogs.endThinkingSegment();
        if (!hasError) micaUI.panels.clearAgentTurnLogItems();
        this.queue.finishRun();
      }
      logRuntime('runtime', 'turn:finish', { elapsedMs: Date.now() - startedAt, hasError });
    }
  }
}
