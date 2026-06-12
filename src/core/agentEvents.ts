import { agentTurn } from '../agent/turn.js';
import type { WorkingStatus } from '../store/uiState.js';
import type { StreamCreatePayload } from '../agent/types.js';
import {
  handleThinkingChunk,
  handleStreamStart,
  handleStreamChunk,
  handleFinalMessage,
  handleToolUseStart,
  handleToolUseComplete,
  handleStatus,
  appendToolOutputChunk,
} from '../store/streamHandlers.js';

export function setupAgentEvents() {
  let lastStatus: WorkingStatus | null = null;
  let textStarted = false;

  agentTurn.events.on('stream:create', (payload: StreamCreatePayload) => {
    textStarted = false;
    const stream = payload.stream;

    stream.on('thinking', (chunk: string) => {
      handleThinkingChunk(chunk);
    });

    stream.on('text', (chunk: string) => {
      if (!textStarted) {
        textStarted = true;
        handleStreamStart();
      }
      handleStreamChunk(chunk);
    });
  });

  agentTurn.events.on('message:final', () => {
    handleFinalMessage();
  });

  agentTurn.events.on('tool:use', ({ toolUseId, toolName, toolInput, completed, elapsedMs }) => {
    if (completed) {
      handleToolUseComplete(toolUseId, toolName, toolInput, elapsedMs ?? 0);
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
