import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { agentTurn } from '../agent/turn.js';
import { appendSystemLog } from '../store/logAtom.js';
import type { WorkingStatus } from '../store/ui-state.js';
import {
  handleThinkingChunk,
  handleStreamStart,
  handleStreamChunk,
  handleStreamEnd,
  handleFinalMessage,
  handleToolUseStart,
  handleToolUseComplete,
  handleStatus,
  appendToolOutputChunk,
} from '../store/stream-handlers.js';

export function setupAgentEvents() {
  let lastStatus: WorkingStatus | null = null;
  let textStarted = false;

  agentTurn.events.on('stream:create', (stream: MessageStream<null>) => {
    appendSystemLog('流：创建消息流');
    textStarted = false;

    stream.on('thinking', (chunk) => {
      handleThinkingChunk(chunk);
    });

    stream.on('text', (chunk) => {
      if (!textStarted) {
        textStarted = true;
        handleStreamStart();
      }
      handleStreamChunk(chunk);
    });

    stream.on('end', () => {
      handleStreamEnd();
    });
  });

  agentTurn.events.on('message:final', () => {
    handleFinalMessage();
  });

  agentTurn.events.on('tool:use', ({ toolUseId, toolName, toolInput, completed }) => {
    if (completed) {
      handleToolUseComplete(toolUseId, toolName, toolInput);
    } else {
      handleToolUseStart(toolUseId, toolName, toolInput);
    }
  });

  agentTurn.events.on('status', (status) => {
    handleStatus(status, lastStatus);
    lastStatus = status;
  });

  agentTurn.events.on('tool:output', ({ toolUseId, chunk }) => {
    appendToolOutputChunk(toolUseId, chunk);
  });
}
