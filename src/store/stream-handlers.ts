import { thinkingTextAtom, responseTextAtom, toolCallsAtom, workingStatusAtom } from './ui-state.js';
import type { WorkingStatus, ToolCallData } from './ui-state.js';
import { appendSystemLog } from './logAtom.js';
import { getToolDisplayText } from '../tools/index.js';
import { ui } from '../components/ui/index.js';

const toolOutputBuffers = new Map<string, string[]>();

function upsertToolCall(id: string, patch: Partial<ToolCallData>, fallback: ToolCallData) {
  const existing = toolCallsAtom.get();
  const idx = existing.findIndex((t) => t.id === id);
  if (idx !== -1) {
    const updated = [...existing];
    updated[idx] = { ...updated[idx], ...patch };
    toolCallsAtom.set(updated);
  } else {
    toolCallsAtom.set([...existing, fallback]);
  }
}

export function flushToolOutputBuffer(toolUseId: string) {
  const chunks = toolOutputBuffers.get(toolUseId);
  if (chunks && chunks.length > 0) {
    thinkingTextAtom.set(thinkingTextAtom.get() + chunks.join(''));
    toolOutputBuffers.delete(toolUseId);
  }
}

export function appendToolOutputChunk(toolUseId: string, chunk: string) {
  const buf = toolOutputBuffers.get(toolUseId) || [];
  buf.push(chunk);
  toolOutputBuffers.set(toolUseId, buf);
}

export function clearToolOutputBuffers() {
  toolOutputBuffers.clear();
}

export function onThinkingChunk(chunk: string) {
  thinkingTextAtom.set(thinkingTextAtom.get() + chunk);
  workingStatusAtom.set({ type: 'thinking' });
}

export function onStreamStart() {
  appendSystemLog('流：开始文本输出');
  toolCallsAtom.set([]);
  thinkingTextAtom.set('');
  responseTextAtom.set('');
  clearToolOutputBuffers();
}

export function onStreamChunk(chunk: string) {
  workingStatusAtom.set({ type: 'streaming' });
  responseTextAtom.set(responseTextAtom.get() + chunk);
}

export function onStreamEnd() {
  appendSystemLog('流：消息流结束');
}

export function onFinalMessage() {
  responseTextAtom.set('');
  thinkingTextAtom.set('');
  toolCallsAtom.set([]);
  clearToolOutputBuffers();
}

export function onToolUseStart(toolUseId: string, toolName: string, toolInput: Record<string, any>) {
  const displayText = getToolDisplayText(toolName, toolInput);
  appendSystemLog(`工具调用：${toolName}`);

  upsertToolCall(toolUseId, { displayText }, {
    id: toolUseId, toolName, toolInput, completed: false, displayText,
  });
}

export function onToolUseComplete(toolUseId: string, toolName: string, toolInput: Record<string, any>) {
  appendSystemLog(`工具完成：${toolName}`);
  flushToolOutputBuffer(toolUseId);

  const displayText = getToolDisplayText(toolName, toolInput);
  upsertToolCall(toolUseId, { completed: true, displayText, status: undefined }, {
    id: toolUseId, toolName, toolInput, completed: true, displayText,
  });
}

export function onToolSlow(toolUseId: string, elapsedMs: number) {
  upsertToolCall(toolUseId, { elapsedMs }, {
    id: toolUseId, toolName: '', toolInput: {}, completed: false, displayText: '', elapsedMs,
  });
}

export function onStatus(status: WorkingStatus, lastStatus: WorkingStatus | null) {
  if (shouldLogStatus(status, lastStatus)) {
    appendSystemLog(formatStatusLog(status));
  }

  if (status.type === 'connecting') {
    toolCallsAtom.set([]);
    thinkingTextAtom.set('');
    responseTextAtom.set('');
    clearToolOutputBuffers();
    ui.MessageBar.clearMessages();
  }

  if (status.type === 'calling_tool') {
    const calls = toolCallsAtom.get();
    let changed = false;
    for (const call of calls) {
      if (!call.completed && call.status !== 'executing') {
        call.status = 'executing';
        changed = true;
      }
    }
    if (changed) toolCallsAtom.set([...calls]);
  }

  if (status.type === 'idle') {
    clearToolOutputBuffers();
  }

  workingStatusAtom.set(status);
}

function formatStatusLog(status: WorkingStatus): string {
  switch (status.type) {
    case 'idle': return '状态：空闲';
    case 'connecting': return '状态：连接 API';
    case 'thinking': return '状态：思考中';
    case 'streaming': return '状态：流式输出';
    case 'calling_tool':
      return status.elapsedMs != null
        ? `状态：执行工具 (${(status.elapsedMs / 1000).toFixed(1)}s)`
        : '状态：执行工具';
    case 'completed':
      return status.elapsedMs != null
        ? `状态：完成 (${(status.elapsedMs / 1000).toFixed(1)}s)`
        : '状态：完成';
    case 'error':
      return `状态：错误${status.message ? ` — ${status.message}` : ''}`;
    default:
      return '状态：未知';
  }
}

function shouldLogStatus(status: WorkingStatus, prev: WorkingStatus | null): boolean {
  if (!prev || status.type !== prev.type) return true;
  if (status.type === 'calling_tool' && prev.type === 'calling_tool') {
    return prev.elapsedMs == null && status.elapsedMs != null;
  }
  if (status.type === 'error' && prev.type === 'error') {
    return status.message !== prev.message;
  }
  return false;
}
