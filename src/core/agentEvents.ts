import type Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { agentTurn } from '../agent/turn.js';
import { messagesAtom } from '../store/conversation.js';
import { appendSystemLog } from '../store/logAtom.js';
import { logTextAtom, toolCallsAtom, workingStatusAtom } from '../store/ui-state.js';
import type { WorkingStatus } from '../store/ui-state.js';
import { ui } from '../components/ui/index.js';
import { getToolDisplayText } from '../tools/index.js';

type StreamingMessage = Anthropic.MessageParam & { status?: 'streaming' };

export function setupAgentEvents() {
  let lastStatus: WorkingStatus | null = null;
  const logBuffers = new Map<string, string[]>();

  const flushLogBuffer = (toolUseId: string) => {
    const chunks = logBuffers.get(toolUseId);
    if (chunks && chunks.length > 0) {
      logTextAtom.set(logTextAtom.get() + chunks.join(''));
      logBuffers.delete(toolUseId);
    }
  };

  const clearLogBuffers = () => logBuffers.clear();

  agentTurn.events.on('stream:create', (stream: MessageStream<null>) => {
    appendSystemLog('流：创建消息流');
    let thinkingText = '';
    let streamingText = '';
    let textStarted = false;

    stream.on('thinking', (chunk) => {
      thinkingText += chunk;
      logTextAtom.set(thinkingText);
      workingStatusAtom.set({ type: 'thinking' });
    });

    stream.on('text', (chunk) => {
      if (!textStarted) {
        textStarted = true;
        appendSystemLog('流：开始文本输出');
        toolCallsAtom.set([]);
        logTextAtom.set('');
        clearLogBuffers();
      }
      workingStatusAtom.set({ type: 'streaming' });
      streamingText += chunk;

      const messages = messagesAtom.get() as StreamingMessage[];
      const streamingIdx = messages.findIndex((msg) => msg.status === 'streaming');

      const streamingMsg: StreamingMessage = {
        role: 'assistant' as const,
        content: streamingText,
        status: 'streaming',
      };

      if (streamingIdx !== -1) {
        const updated = [...messages];
        updated[streamingIdx] = streamingMsg;
        messagesAtom.set(updated);
      } else {
        messagesAtom.set([...messages, streamingMsg]);
      }
    });

    stream.on('end', () => {
      appendSystemLog('流：消息流结束');
      const messages = messagesAtom.get() as StreamingMessage[];
      const streamingIdx = messages.findIndex((msg) => msg.status === 'streaming');
      if (streamingIdx !== -1) {
        messagesAtom.set(messages.filter((_, i) => i !== streamingIdx));
      }
      toolCallsAtom.set([]);
      logTextAtom.set('');
      clearLogBuffers();
    });
  });

  agentTurn.events.on('tool:use', ({ toolUseId, toolName, toolInput, completed }) => {
    const displayText = getToolDisplayText(toolName, toolInput);
    const existing = toolCallsAtom.get();
    const idx = existing.findIndex((t) => t.id === toolUseId);

    if (completed) {
      appendSystemLog(`工具完成：${toolName}`);
      flushLogBuffer(toolUseId);
    } else if (idx === -1) {
      appendSystemLog(`工具调用：${toolName}`);
    }

    if (idx !== -1) {
      const updated = [...existing];
      updated[idx] = {
        ...updated[idx],
        completed,
        displayText,
        status: completed ? undefined : updated[idx].status,
      };
      toolCallsAtom.set(updated);
    } else {
      toolCallsAtom.set([
        ...existing,
        { id: toolUseId, toolName, toolInput, completed, displayText },
      ]);
    }
  });

  agentTurn.events.on('tool:slow', ({ toolUseId, elapsedMs }) => {
    const existing = toolCallsAtom.get();
    const idx = existing.findIndex((t) => t.id === toolUseId);
    if (idx !== -1) {
      const updated = [...existing];
      updated[idx] = { ...updated[idx], elapsedMs };
      toolCallsAtom.set(updated);
    }
  });

  agentTurn.events.on('status', (status) => {
    if (shouldLogStatus(status, lastStatus)) {
      appendSystemLog(formatStatusLog(status));
    }
    lastStatus = status;

    if (status.type === 'connecting') {
      toolCallsAtom.set([]);
      logTextAtom.set('');
      clearLogBuffers();
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
      clearLogBuffers();
    }

    workingStatusAtom.set(status);
  });

  agentTurn.events.on('log:chunk', ({ toolUseId, chunk }) => {
    const buf = logBuffers.get(toolUseId) || [];
    buf.push(chunk);
    logBuffers.set(toolUseId, buf);
  });
}

function formatStatusLog(status: WorkingStatus): string {
  switch (status.type) {
    case 'idle':
      return '状态：空闲';
    case 'connecting':
      return '状态：连接 API';
    case 'thinking':
      return '状态：思考中';
    case 'streaming':
      return '状态：流式输出';
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
