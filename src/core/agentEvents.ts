import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { agentTurn } from '../agent/turn.js';
import { appendSystemLog } from '../store/logAtom.js';
import type { WorkingStatus } from '../store/ui-state.js';
import {
  onThinkingChunk,
  onStreamStart,
  onStreamChunk,
  onStreamEnd,
  onFinalMessage,
  onToolUseStart,
  onToolUseComplete,
  onToolSlow,
  onStatus,
  appendToolLogChunk,
} from '../store/agent-actions.js';

export function setupAgentEvents() {
  let lastStatus: WorkingStatus | null = null;
  let textStarted = false;

  agentTurn.events.on('stream:create', (stream: MessageStream<null>) => {
    appendSystemLog('流：创建消息流');
    textStarted = false;

    stream.on('thinking', (chunk) => {
      onThinkingChunk(chunk);
    });

    stream.on('text', (chunk) => {
      if (!textStarted) {
        textStarted = true;
        onStreamStart();
      }
      onStreamChunk(chunk);
    });

    stream.on('end', () => {
      onStreamEnd();
    });
  });

  agentTurn.events.on('message:final', () => {
    onFinalMessage();
  });

  agentTurn.events.on('tool:use', ({ toolUseId, toolName, toolInput, completed }) => {
    if (completed) {
      onToolUseComplete(toolUseId, toolName, toolInput);
    } else {
      onToolUseStart(toolUseId, toolName, toolInput);
    }
  });

  agentTurn.events.on('tool:slow', ({ toolUseId, elapsedMs }) => {
    onToolSlow(toolUseId, elapsedMs);
  });

  agentTurn.events.on('status', (status) => {
    onStatus(status, lastStatus);
    lastStatus = status;
  });

  agentTurn.events.on('log:chunk', ({ toolUseId, chunk }) => {
    appendToolLogChunk(toolUseId, chunk);
  });
}
