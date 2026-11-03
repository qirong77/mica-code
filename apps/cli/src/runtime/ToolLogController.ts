import { micaUi } from '@packages/mica-ui/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import type { MicaUiAgentTurnLogItem } from '@packages/mica-ui/index.js';

type ActiveToolCall = { id: string; startTime: number; displayText: string };
type ToolLogSink = {
  setThinkingText(text: string): void;
  appendAgentTurnLogItem(item: MicaUiAgentTurnLogItem): void;
  replaceAgentTurnLogItem(item: MicaUiAgentTurnLogItem): void;
};

const MAX_THINKING_BUFFER_CHARS = runtimeEnv.ui.thinkingTextMaxChars;
const THINKING_TRUNCATION_MARKER = '[thinking display truncated]\n';
const THINKING_UI_UPDATE_INTERVAL_MS = runtimeEnv.ui.thinkingUpdateIntervalMs;

const defaultSink: ToolLogSink = {
  setThinkingText: (text) => micaUi.panels.thinkingText.set(text),
  appendAgentTurnLogItem: (item) => micaUi.panels.appendAgentTurnLogItem(item),
  replaceAgentTurnLogItem: (item) => micaUi.panels.replaceAgentTurnLogItem(item),
};

export class ToolLogController {
  private toolId = 0;
  private thinkingId = 0;
  private thinkingBuffer = '';
  private activeThinkingId: string | null = null;
  private lastThinkingUiUpdateAt = 0;
  // The value is the text at the last completed reasoning checkpoint, or null
  // for a row created since then. Keep it even after a segment is flushed.
  private uncheckpointedThinking = new Map<string, string | null>();
  // Unlike a request checkpoint, a turn attempt spans every completed response.
  private turnAttemptThinking: Map<string, string | null> | null = null;
  private turnAttemptCheckpoint: ReturnType<ToolLogController['checkpointThinking']> | null = null;
  private activeToolCalls = new Map<string, ActiveToolCall>();

  constructor(private readonly sink: ToolLogSink = defaultSink) {}

  resetTurn(options: { clearThinkingText?: boolean } = {}) {
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    this.lastThinkingUiUpdateAt = 0;
    this.uncheckpointedThinking.clear();
    this.turnAttemptThinking = null;
    this.turnAttemptCheckpoint = null;
    this.activeToolCalls.clear();
    if (options.clearThinkingText !== false) this.sink.setThinkingText('');
  }

  resetAll() {
    this.toolId = 0;
    this.thinkingId = 0;
    this.resetTurn();
  }

  checkpointThinking() {
    return {
      buffer: this.thinkingBuffer,
      id: this.activeThinkingId,
      lastUpdate: this.lastThinkingUiUpdateAt,
      uncheckpointed: new Map(this.uncheckpointedThinking),
    };
  }

  hasUncheckpointedThinking(): boolean {
    return this.uncheckpointedThinking.size > 0;
  }

  restoreThinking(checkpoint: ReturnType<ToolLogController['checkpointThinking']>) {
    this.thinkingBuffer = checkpoint.buffer;
    this.activeThinkingId = checkpoint.id;
    this.lastThinkingUiUpdateAt = checkpoint.lastUpdate;
    this.uncheckpointedThinking = new Map(checkpoint.uncheckpointed);
    this.sink.setThinkingText(checkpoint.buffer);
    if (checkpoint.id) {
      this.sink.replaceAgentTurnLogItem(micaUi.createThinkingLogItem(checkpoint.id, checkpoint.buffer));
    }
  }

  beginTurnAttempt() {
    this.flushThinking();
    this.turnAttemptCheckpoint = this.checkpointThinking();
    this.turnAttemptThinking = new Map();
  }

  /** Revert only thinking touched by this run, preserving tool and text rows. */
  rollbackTurnAttemptThinking(): Array<{ id: string; text: string | null }> {
    if (!this.turnAttemptThinking || !this.turnAttemptCheckpoint) return [];
    const checkpoint = this.turnAttemptCheckpoint;
    // 交回的是「尝试开始时那一行长什么样」，不是它现在的文本：本次尝试新开的那几行
    // 要整行撤掉（`null`），否则重试前的回滚会把失败尝试的思考又原样贴回去。
    const changes = Array.from(this.turnAttemptThinking.keys(), (id) => ({
      id,
      text: id === checkpoint.id ? checkpoint.buffer : (checkpoint.uncheckpointed.get(id) ?? null),
    }));
    this.restoreThinking(checkpoint);
    this.turnAttemptThinking = null;
    this.turnAttemptCheckpoint = null;
    return changes;
  }

  /** Record completed reasoning independently of the retry-attempt snapshot. */
  markThinkingCheckpoint() {
    this.flushThinking();
    this.uncheckpointedThinking.clear();
  }

  /** Return the thinking rows to restore/remove, without touching other log rows. */
  rollbackUncheckpointedThinking(): Array<{ id: string; text: string | null }> {
    const changes = Array.from(this.uncheckpointedThinking, ([id, text]) => ({ id, text }));
    if (!changes.length) return changes;

    if (this.activeThinkingId && this.uncheckpointedThinking.has(this.activeThinkingId)) {
      const text = this.uncheckpointedThinking.get(this.activeThinkingId)!;
      this.thinkingBuffer = text ?? '';
      if (text === null) this.activeThinkingId = null;
      this.lastThinkingUiUpdateAt = 0;
      this.sink.setThinkingText(this.thinkingBuffer);
    }
    this.uncheckpointedThinking.clear();
    return changes;
  }

  flushThinking() {
    if (!this.activeThinkingId) return;
    this.sink.setThinkingText(this.thinkingBuffer);
    this.sink.replaceAgentTurnLogItem(micaUi.createThinkingLogItem(this.activeThinkingId, this.thinkingBuffer));
  }

  endThinkingSegment() {
    // The display can contain an earlier interrupted turn even when this
    // controller has no active segment. An idle status during retry must not
    // clear that restored text.
    if (!this.activeThinkingId) return;
    this.sink.replaceAgentTurnLogItem(micaUi.createThinkingLogItem(this.activeThinkingId, this.thinkingBuffer));
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    this.lastThinkingUiUpdateAt = 0;
    this.sink.setThinkingText('');
  }

  appendThinking(text: string) {
    if (!text) return;
    if (!this.activeThinkingId) {
      this.activeThinkingId = `thinking-${++this.thinkingId}`;
      this.thinkingBuffer = '';
      this.uncheckpointedThinking.set(this.activeThinkingId, null);
      this.turnAttemptThinking?.set(this.activeThinkingId, null);
    } else if (!this.uncheckpointedThinking.has(this.activeThinkingId)) {
      this.uncheckpointedThinking.set(this.activeThinkingId, this.thinkingBuffer);
    }
    if (this.turnAttemptThinking && !this.turnAttemptThinking.has(this.activeThinkingId)) {
      this.turnAttemptThinking.set(this.activeThinkingId, this.thinkingBuffer);
    }
    this.thinkingBuffer = appendBoundedText(
      this.thinkingBuffer,
      text,
      MAX_THINKING_BUFFER_CHARS,
      THINKING_TRUNCATION_MARKER,
    );
    const now = Date.now();
    if (now - this.lastThinkingUiUpdateAt < THINKING_UI_UPDATE_INTERVAL_MS) return;
    this.lastThinkingUiUpdateAt = now;
    this.sink.setThinkingText(this.thinkingBuffer);
    this.sink.replaceAgentTurnLogItem(micaUi.createThinkingLogItem(this.activeThinkingId, this.thinkingBuffer));
  }

  addToolCall({ name, args, id }: { name: string; args: string; id?: string }) {
    this.endThinkingSegment();
    const toolKey = id ?? `${name}-${this.toolId + 1}`;
    const toolLogId = `tool-${++this.toolId}`;
    const displayText = this.getToolDisplayText(name, args);

    this.activeToolCalls.set(toolKey, {
      id: toolLogId,
      startTime: Date.now(),
      displayText,
    });
    this.sink.appendAgentTurnLogItem(
      micaUi.createToolCallLogItem({
        id: toolLogId,
        toolName: name,
        displayText,
        completed: false,
        startTime: this.activeToolCalls.get(toolKey)!.startTime,
      }),
    );
  }

  // 终端只展示一行调用摘要，结果文本不再进日志（网页端才需要它做详情）。
  completeToolCall({ name, id }: { name: string; result: string; id?: string }) {
    this.endThinkingSegment();
    const toolKey = id ?? this.findFirstActiveToolKey(name);
    const activeTool = toolKey ? this.activeToolCalls.get(toolKey) : undefined;
    const toolLogId = activeTool?.id ?? `tool-${++this.toolId}`;
    const startTime = activeTool?.startTime ?? Date.now();
    const displayText = activeTool?.displayText ?? `${name} result`;

    if (toolKey) this.activeToolCalls.delete(toolKey);

    this.sink.replaceAgentTurnLogItem(
      micaUi.createToolCallLogItem({
        id: toolLogId,
        toolName: name,
        displayText,
        completed: true,
        startTime,
        elapsedMs: Date.now() - startTime,
      }),
    );
  }

  private getToolDisplayText(name: string, args: string) {
    try {
      return micaTools.getDisplayText(name, JSON.parse(args));
    } catch {
      return `${name} ${args}`;
    }
  }

  private findFirstActiveToolKey(toolName: string): string | undefined {
    for (const [key, value] of this.activeToolCalls) {
      if (value.displayText.startsWith(`${toolName} `)) return key;
    }
    return undefined;
  }
}

function appendBoundedText(previous: string, chunk: string, maxChars: number, marker: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= maxChars) return next;
  const body = next.startsWith(marker) ? next.slice(marker.length) : next;
  return `${marker}${body.slice(-(maxChars - marker.length))}`;
}
