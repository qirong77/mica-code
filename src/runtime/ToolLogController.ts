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
  private activeToolCalls = new Map<string, ActiveToolCall>();

  constructor(private readonly sink: ToolLogSink = defaultSink) {}

  resetTurn(options: { clearThinkingText?: boolean } = {}) {
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    this.lastThinkingUiUpdateAt = 0;
    this.activeToolCalls.clear();
    if (options.clearThinkingText !== false) this.sink.setThinkingText('');
  }

  resetAll() {
    this.toolId = 0;
    this.thinkingId = 0;
    this.resetTurn();
  }

  endThinkingSegment() {
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    this.sink.setThinkingText('');
  }

  appendThinking(text: string) {
    if (!this.activeThinkingId) {
      this.activeThinkingId = `thinking-${++this.thinkingId}`;
      this.thinkingBuffer = '';
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

  completeToolCall({ name, result, id }: { name: string; result: string; id?: string }) {
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
        output: result.slice(0, 2000),
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
