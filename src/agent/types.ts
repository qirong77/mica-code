import Anthropic from '@anthropic-ai/sdk';
import type { WorkingStatus } from '../store/ui-state.js';

export interface StreamCreatePayload {
  stream: any;
  iterationId: number;
}

export interface ToolUsePayload {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, any>;
  completed: boolean;
  elapsedMs?: number;
  iterationId?: number;
}

export interface MessageFinalPayload {
  message: Anthropic.Message;
  iterationId: number;
}

export type AgentTurnEvents = {
  'stream:create': StreamCreatePayload;
  'tool:use': ToolUsePayload;
  status: WorkingStatus;
  'tool:output': { toolUseId: string; chunk: string };
  'message:final': MessageFinalPayload;
};

export interface IterationResult {
  hasToolUse: boolean;
  wasTruncated: boolean;
  finalMessage: Anthropic.Message;
  iterationId: number;
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
