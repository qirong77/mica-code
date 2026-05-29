import { thinkingTextAtom, responseTextAtom, workingStatusAtom } from './ui-state.js';
import type { WorkingStatus } from './ui-state.js';
import { appendSystemLog } from './logAtom.js';
import { ui } from '../components/ui/index.js';
import { getToolDisplayText } from '../tools/index.js';

const toolOutputBuffers = new Map<string, string[]>();

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

export function handleThinkingChunk(chunk: string) {
  thinkingTextAtom.set(thinkingTextAtom.get() + chunk);
  workingStatusAtom.set({ type: 'thinking' });
}

export function handleStreamStart() {
  thinkingTextAtom.set('');
  responseTextAtom.set('');
  clearToolOutputBuffers();
}

export function handleStreamChunk(chunk: string) {
  workingStatusAtom.set({ type: 'streaming' });
  responseTextAtom.set(responseTextAtom.get() + chunk);
}

export function handleFinalMessage() {
  responseTextAtom.set('');
  thinkingTextAtom.set('');
  clearToolOutputBuffers();
}

export function handleToolUseStart(_toolUseId: string, _toolName: string, _toolInput: Record<string, any>) {
}

export function handleToolUseComplete(toolUseId: string, toolName: string, toolInput: Record<string, any>, elapsedMs: number) {
  flushToolOutputBuffer(toolUseId);
  const display = getToolDisplayText(toolName, toolInput);
  const elapsed = elapsedMs >= 1000
    ? `${(elapsedMs / 1000).toFixed(1)}s`
    : `${elapsedMs}ms`;
  appendSystemLog(`${display} · ${elapsed}`);
}

export function handleStatus(status: WorkingStatus, lastStatus: WorkingStatus | null) {
  if (shouldLogStatus(status, lastStatus)) {
    appendSystemLog(formatStatusLog(status));
  }

  if (status.type === 'connecting') {
    thinkingTextAtom.set('');
    responseTextAtom.set('');
    clearToolOutputBuffers();
    ui.MessageBar.clearMessages();
  }

  if (status.type === 'idle') {
    clearToolOutputBuffers();
  }

  workingStatusAtom.set(status);
}

function formatStatusLog(status: WorkingStatus): string {
  switch (status.type) {
    case 'connecting': return '连接 API';
    case 'thinking': return '思考中';
    case 'streaming': return '流式输出';
    case 'calling_tool':
      return status.elapsedMs != null
        ? `执行工具 (${(status.elapsedMs / 1000).toFixed(1)}s)`
        : '执行工具';
    case 'completed':
      return status.elapsedMs != null
        ? `完成 (${(status.elapsedMs / 1000).toFixed(1)}s)`
        : '完成';
    case 'error':
      return status.message ? `错误 — ${status.message}` : '错误';
    default:
      return '未知';
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
