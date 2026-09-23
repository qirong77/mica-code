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
  threadResume: 'thread/resume',
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

/**
 * Mica extension notifications for long-lived host state that outlives a single
 * turn: background shell tasks (`run_shell` background/`background_tasks`) and
 * subagents (including `run_in_background: true` tasks still running after the
 * parent turn finished). The Codex protocol has no event for either, so the
 * desktop app would otherwise lose the input-above-composer status rows the
 * CLI shows. Both are snapshot pushes: the client replaces its whole list on
 * each update, and the host only emits when the serialized snapshot changed.
 */
export const MICA_TASK_NOTIFICATIONS = {
  backgroundTasksUpdated: 'mica/backgroundTasks/updated',
  subagentTasksUpdated: 'mica/subagentTasks/updated',
} as const;

/**
 * Mica extension notification: the session_compact tool replaced the persisted
 * conversation history mid-host. The Codex protocol has no event for it, so
 * the desktop app would otherwise keep showing the stale transcript until the
 * session is reopened. Emitted once per applied history replacement; the
 * client reloads the session file.
 */
export const MICA_SESSION_NOTIFICATIONS = {
  historyReplaced: 'mica/sessionHistory/replaced',
} as const;

/**
 * Mica extension requests (client -> host). The Codex protocol has no request
 * for these, so the desktop app needs Mica-specific ones:
 *
 * - `mica/turn/editMessage`: the Codex protocol can only append turns, so an
 *   "edit a message that was already sent" affordance (the desktop app's
 *   double-click editor) needs a way to rewind the conversation first. The
 *   message is located by its (whitespace-folded) text — persisted histories
 *   carry no per-message id — then truncated together with everything after it,
 *   saved, and rerun with the edited text.
 * - `mica/backgroundTasks/kill` / `mica/backgroundTasks/output`: long-lived
 *   background shell tasks are owned by the host process, so stopping one or
 *   reading its output can only go through it.
 * - `mica/subagentTasks/detail` / `mica/subagentTasks/kill`: subagent records
 *   (prompt, streamed timeline, result, usage) live in the host's
 *   `SubagentTaskManager` and are never persisted, so the desktop's detail modal
 *   reads them from the host.
 *
 * Codex clients never send them; the host answers unknown methods with
 * method-not-found, so a Codex driver is unaffected.
 */
export const MICA_METHODS = {
  editMessage: 'mica/turn/editMessage',
  /** Pull a queued (after_iteration) input back out of the host's single slot
   * so the client can restore it to its composer — the CLI's shift + ←. */
  queueRecall: 'mica/queue/recall',
  killBackgroundTask: 'mica/backgroundTasks/kill',
  backgroundTaskOutput: 'mica/backgroundTasks/output',
  subagentTaskDetail: 'mica/subagentTasks/detail',
  killSubagentTask: 'mica/subagentTasks/kill',
} as const;

export type MicaEditMessageParams = {
  /** Original text of the message being edited (matched against user messages). */
  prompt: string;
  /** Replacement text; runs as the new turn's input. */
  text: string;
  /**
   * 1-based index counting matching user messages from the end, for sessions
   * where the same text was sent more than once. Defaults to 1 (the newest).
   */
  occurrenceFromEnd?: number;
  model?: string;
  effort?: string;
};

export type MicaBackgroundTaskItem = {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  status: 'starting' | 'running' | 'finished' | 'killed' | 'failed' | 'unknown_exited';
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
};

export type MicaSubagentTaskItem = {
  taskId: string;
  parentTaskId?: string | null;
  subagentType: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: string;
  finishedAt?: string | null;
  activities?: { id: string; summary: string; toolName?: string; startedAt: string }[];
};

export type MicaKillBackgroundTaskParams = {
  taskId: string;
  /** Milliseconds to wait before escalating to SIGKILL; the host defaults it. */
  forceAfterMs?: number;
};

export type MicaKillBackgroundTaskResult = {
  ok: boolean;
  message: string;
  stillRunning?: boolean;
};

export type MicaBackgroundTaskOutputParams = {
  taskId: string;
  /** Read the last N bytes instead of the head; the host clamps it to its own cap. */
  tailBytes?: number;
};

export type MicaBackgroundTaskOutputResult = {
  ok: boolean;
  message?: string;
  /** Cleaned output (Mica bookkeeping markers stripped, no ANSI). */
  content: string;
  /** Total size of the task's output file, so the client can show what it is not seeing. */
  size: number;
  start: number;
  end: number;
  /**
   * Current projection of the task. The periodic snapshot only carries running
   * tasks, so a client showing a task's output would otherwise lose the status
   * (and the exit code) the moment it finishes.
   */
  task?: MicaBackgroundTaskItem | null;
};

/** One streamed step of a subagent's own activity, in the order it happened. */
export type MicaSubagentTimelineEntry = {
  id: string;
  kind: 'thinking' | 'text' | 'tool' | 'tool_result';
  /** Thinking/text content, tool arguments, or the tool result. */
  text: string;
  toolName?: string;
  at: string;
};

export type MicaSubagentUsageSummary = {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

/**
 * One subagent task as the desktop's detail modal needs it. The periodic
 * `mica/subagentTasks/updated` snapshot stays lean (running tasks only, no
 * transcript); this is fetched on demand while a detail modal is open.
 */
export type MicaSubagentTaskDetail = {
  taskId: string;
  parentTaskId?: string | null;
  subagentType: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: string;
  finishedAt?: string | null;
  model?: string;
  effort?: string;
  maxTurns?: number;
  contextMode?: string;
  writeMode?: string;
  ownedPaths?: string[];
  contextFiles?: string[];
  prompt?: string;
  result?: string;
  error?: string;
  usage?: MicaSubagentUsageSummary;
  timeline?: MicaSubagentTimelineEntry[];
  /** True once older timeline entries were dropped to bound the record. */
  timelineTruncated?: boolean;
};

export type MicaSubagentTaskDetailParams = {
  taskId: string;
};

export type MicaSubagentTaskDetailResult = {
  ok: boolean;
  message?: string;
  task?: MicaSubagentTaskDetail;
};

export type MicaKillSubagentTaskParams = {
  taskId: string;
};

export type MicaKillSubagentTaskResult = {
  ok: boolean;
  message: string;
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
