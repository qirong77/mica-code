/**
 * Codex v2 App Server protocol subset implemented by `mica app-server`.
 *
 * The wire format matches OpenAI Codex's app-server protocol (JSON-RPC style
 * over stdio, one JSON object per line, no `jsonrpc: "2.0"` field):
 *
 *   client -> server:  {"id": 1, "method": "turn/start", "params": {...}}
 *                      {"method": "initialized"}
 *   server -> client:  {"id": 1, "result": {...}}
 *                      {"id": 1, "error": {...}}
 *                      {"method": "turn/started", "params": {...}, "emittedAtMs": 123}
 *
 * Only the subset needed to drive a resident session is implemented. Unknown
 * methods get a JSON-RPC method-not-found error so clients can negotiate.
 */

export type CodexRequestId = number | string;

export type CodexJsonRpcMessage =
  | { id: CodexRequestId; method: string; params?: unknown; trace?: unknown }
  | { method: string; params?: unknown }
  | { id: CodexRequestId; result: unknown }
  | { id: CodexRequestId; error: { code: number; message: string; data?: unknown } };

export function parseCodexLine(line: string): CodexJsonRpcMessage | undefined {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  const method = message.method;
  if (typeof method === 'string' && 'id' in message) {
    return {
      id: message.id as CodexRequestId,
      method,
      params: message.params as unknown,
      trace: message.trace as unknown,
    };
  }
  if (typeof method === 'string') {
    return { method, params: message.params as unknown };
  }
  if ('id' in message && 'result' in message) {
    return { id: message.id as CodexRequestId, result: message.result as unknown };
  }
  if ('id' in message && 'error' in message) {
    return {
      id: message.id as CodexRequestId,
      error: message.error as { code: number; message: string; data?: unknown },
    };
  }
  return undefined;
}

export function encodeCodexResponse(id: CodexRequestId, result: unknown): string {
  return `${JSON.stringify({ id, result })}\n`;
}

export function encodeCodexError(id: CodexRequestId, code: number, message: string, data?: unknown): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return `${JSON.stringify({ id, error })}\n`;
}

export function encodeCodexNotification(method: string, params: unknown, emittedAtMs = Date.now()): string {
  const notification: Record<string, unknown> = { method, params };
  notification.emittedAtMs = emittedAtMs;
  return `${JSON.stringify(notification)}\n`;
}

export const CODEX_ERROR_INVALID_REQUEST = -32600;
export const CODEX_ERROR_METHOD_NOT_FOUND = -32601;
export const CODEX_ERROR_INVALID_PARAMS = -32602;
export const CODEX_ERROR_INTERNAL = -32603;

/** Codex v2 method names this host implements. */
export const CODEX_METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  clientInitialized: 'initialized',
} as const;

/** Notification method names this host emits. */
export const CODEX_NOTIFICATIONS = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',
  error: 'error',
  warning: 'warning',
} as const;

/**
 * Mica extension notifications (incremental: Codex clients ignore unknown
 * notification method names). The Codex protocol has no queue event, so the
 * desktop app would otherwise never learn that a turn/steer input is waiting
 * at the host for its after_iteration boundary.
 */
export const MICA_QUEUE_NOTIFICATIONS = {
  queued: 'mica/queue/queued',
  dequeue: 'mica/queue/dequeue',
  changed: 'mica/queue/changed',
} as const;

export type MicaQueueItem = {
  id: string;
  text: string;
  queueMode?: 'after_iteration' | 'after_turn' | null;
};

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type CodexThreadStatus = 'notLoaded' | 'idle' | 'systemError' | { active: { activeFlags: string[] } };

export type CodexTurnError = {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
};

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  itemsView: 'notLoaded' | 'summary' | 'full';
  status: CodexTurnStatus;
  error?: CodexTurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type CodexThreadItem =
  | { type: 'userMessage'; id: string; clientId?: string | null; content: CodexUserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      /** Mica tool display text (onToolUseDisplayText), so clients render the
       * same tool-call summary as the CLI instead of re-deriving it. */
      displayText?: string | null;
      cwd: string;
      status: 'pending' | 'inProgress' | 'completed' | 'error' | 'cancelled' | 'interrupted';
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | { type: 'fileChange'; id: string; changes: unknown[]; status: string };

export type CodexUserInput =
  | { type: 'text'; text: string; textElements?: unknown[] }
  | { type: 'image'; url: string; detail?: string | null }
  | { type: 'localImage'; path: string; detail?: string | null };

export type CodexThread = {
  id: string;
  status: CodexThreadStatus;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  path?: string | null;
  cliVersion: string;
  source: string;
  modelProvider: string;
  model?: string | null;
  name?: string | null;
  turns?: CodexTurn[];
};

export type CodexTokenUsageBreakdown = {
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  model_context_window: number | null;
};
