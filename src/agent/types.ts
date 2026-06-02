import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import type { WorkingStatus } from '../store/ui-state.js';

export type AgentTurnEvents = {
  'stream:create': MessageStream<null>;
  'tool:use': {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, any>;
    completed: boolean;
    elapsedMs?: number;
  };
  status: WorkingStatus;
  'tool:output': { toolUseId: string; chunk: string };
  'message:final': Anthropic.Message;
};

export interface IterationResult {
  hasToolUse: boolean;
  wasTruncated: boolean;
  finalMessage: Anthropic.Message;
}

export interface CompletedToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
}

export type RunFn = (
  userInput: string,
  onIteration?: (result: IterationResult) => void,
) => Promise<void>;

export type Middleware = (
  userInput: string,
  next: RunFn,
  onIteration?: (result: IterationResult) => void,
) => Promise<void>;

export type AgentTurnEmitter = {
  emit<K extends keyof AgentTurnEvents>(type: K, event: AgentTurnEvents[K]): void;
};
