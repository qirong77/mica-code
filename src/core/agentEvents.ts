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
  onStatus,
  appendToolOutputChunk,
} from '../store/stream-handlers.js';

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

  agentTurn.events.on('status', (status) => {
    onStatus(status, lastStatus);
    lastStatus = status;
  });

  agentTurn.events.on('tool:output', ({ toolUseId, chunk }) => {
    appendToolOutputChunk(toolUseId, chunk);
  });
}
