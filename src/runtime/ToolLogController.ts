import { micaUI } from '../../packages/mica-ui/index.js';
import {
  createThinkingLogItem,
  createToolCallLogItem,
} from '../../packages/agent/ui/AgentTurnLogItems.js';
import { getToolDisplayText } from '../../packages/tools/index.js';
import { logRuntime } from '../logger.js';

type ActiveToolCall = { id: string; startTime: number; displayText: string };

export class ToolLogController {
  private toolId = 0;
  private thinkingId = 0;
  private thinkingBuffer = '';
  private activeThinkingId: string | null = null;
  private activeToolCalls = new Map<string, ActiveToolCall>();

  resetTurn() {
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    this.activeToolCalls.clear();
    micaUI.panels.thinkingText.set('');
  }

  resetAll() {
    this.toolId = 0;
    this.thinkingId = 0;
    this.resetTurn();
  }

  endThinkingSegment() {
    this.thinkingBuffer = '';
    this.activeThinkingId = null;
    micaUI.panels.thinkingText.set('');
  }

  appendThinking(text: string) {
    if (!this.activeThinkingId) {
      this.activeThinkingId = `thinking-${++this.thinkingId}`;
      this.thinkingBuffer = '';
    }
    this.thinkingBuffer += text;
    micaUI.panels.thinkingText.set(this.thinkingBuffer);
    micaUI.panels.replaceAgentTurnLogItem(createThinkingLogItem(this.activeThinkingId, this.thinkingBuffer));
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

    logRuntime('runtime.tool', 'ui:add', { name, id: toolKey });
    micaUI.panels.appendAgentTurnLogItem(
      createToolCallLogItem({
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
    logRuntime('runtime.tool', 'ui:complete', {
      name,
      id: toolKey,
      elapsedMs: Date.now() - startTime,
      resultChars: result.length,
    });

    micaUI.panels.replaceAgentTurnLogItem(
      createToolCallLogItem({
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
      return getToolDisplayText(name, JSON.parse(args));
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
