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
  waitTasksUpdated: 'mica/waitTasks/updated',
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
 * Mica extension notification: the host ran an automatic context compaction
 * (see `apps/cli/src/runtime/autoCompact.ts`) and reports the session's run
 * counters afterwards. The counters are what the desktop app's 自动压缩 panel
 * shows and what it sends back on the next `turn/start` (`autoCompact`), so
 * every applied run — and every skipped one, via `lastNote` — must be pushed,
 * not only the successful compactions. Emitted at an iteration boundary, i.e.
 * while the turn is still running.
 */
export const MICA_AUTO_COMPACT_NOTIFICATIONS = {
  updated: 'mica/autoCompact/updated',
} as const;

/**
 * Mica extension notification: By The Way（btw）线程的快照。
 *
 * CLI 里 btw 是 `/btw <问题>` 命令——一个隔离子代理，拿主流程的对话记录当背景回答
 * 问题，不写回主流程、不进主请求上下文，主流程运行中也能问；`/btw -continue` 复用
 * 同一个子代理追问。桌面端的等价物是输入条上的一个面板：面板里连续追问就是
 * `-continue`，所以「一条线程」在两边是同一个东西（那唯一的子代理活在 host 进程里）。
 *
 * 回答要发一次模型请求，可能几十秒，而 host 的请求处理是逐行 await 的：同步等一个
 * btw 会把 `turn/interrupt`、`turn/steer`、`mica/queue/recall` 堵在它后面——主流程
 * 运行中恰恰最需要它们。所以 `mica/btw/ask` 只收下问题就返回，答案经这里推回：
 *
 * btw 就是一个 mica 运行实例（隔离子代理跑同一套 agent 循环），所以它不是「问完再出
 * 结果」：思考、工具调用、正文都按 delta **流式**推回（host 侧按 ~80ms 合并一次），
 * 抽屉里看到的就是主对话那套实时渲染。也就是说这条通知是高频的，而且**每次推的仍是
 * 整份快照**（客户端整体替换，不做增量合并）。
 *
 * 与主对话的回合日志同款：思考与工具行**只描述正在发生的那一轮**——新问题开始时
 * 上一条的 `thinking`/`tools` 会被清掉（回答留在 `answer` 里），所以快照不会随轮次
 * 线性变大；每条字段还有各自的上限（host 侧截断）。
 *
 * - 与任务快照同样是「整份快照」推送（客户端整体替换），不是增量；
 * - 与任务快照一样**不进 turn 事件缓冲**：btw 不属于任何 turn，回答可能要好几个
 *   turn 之后才到，走事件缓冲只会把 text/step_finish 这类真事件挤掉。
 */
export const MICA_BTW_NOTIFICATIONS = {
  updated: 'mica/btw/updated',
} as const;

export type MicaBtwEntry = {
  id: string;
  question: string;
  /**
   * `aborted`：用户主动停止（面板的停止按钮）。
   *
   * 与 `error` 分开是有意义的：中断不是失败，界面上不该显示成一次报错；
   * 已经流出来的那段正文仍然是这一问的答案（见下面的 `answer`）。
   */
  status: 'running' | 'completed' | 'error' | 'aborted';
  /**
   * 回答正文。`status === 'completed'` 时是最终答案；还在跑时是**已经流出的那一部分**
   * （面板据此像主对话一样逐字渲染，而不是干等一次请求结束）。
   */
  answer?: string;
  /**
   * 思考过程（`running` 或刚完成的那一条才有，见下面的「日志只描述当前一轮」）。
   *
   * 与主对话的回合日志同款：它是**流式**的，也是**有界的**（host 侧按字符数截断尾部）。
   */
  thinking?: string;
  /** 这一轮回答里已经发生的工具调用（同上有界、只属于当前一轮）。 */
  tools?: MicaBtwToolCall[];
  /** 失败原因（`status === 'error'` 时才有）。 */
  error?: string;
  startedAt: string;
  finishedAt?: string | null;
};

/**
 * By The Way 里的一次工具调用。
 *
 * 字段与桌面端回合日志里那份工具行（`chat-tool-display.js` 的 `toolCallText`/`toolOutput`）
 * 一一对应，所以抽屉可以直接用同一套组件渲染——btw 是一个 mica 运行实例，它跑工具的样子
 * 就该和主对话里一模一样。
 */
export type MicaBtwToolCall = {
  /** 工具调用 id（host 侧用来把「开始」与「结果」两个回调对上）。 */
  id: string;
  /** 工具名（`read_file` 等）。 */
  tool: string;
  /** 已经解析好的入参；解析失败时是 `{ value: 原始文本 }`。 */
  input?: unknown;
  /** app-server 给的展示文案（带工具语义），缺失时渲染层回退到「工具名 + 摘要」。 */
  displayText?: string | null;
  status: 'running' | 'completed';
  /** 工具结果（host 侧按字符数截断）。 */
  output?: string;
  startedAt: string;
  finishedAt?: string | null;
};

/** 一整条 btw 线程（问答 + 线程 id）。 */
export type MicaBtwThread = {
  /** 线程 id。`newThread` 重置后换一个，客户端据此丢弃上一串问答。 */
  id: string;
  /** 有界：只保留最近若干条（host 侧裁剪），顺序即时间顺序。 */
  entries: MicaBtwEntry[];
  /**
   * 这条线程自己的模型与上下文占用（子代理是独立的一次运行，与主对话的
   * `meta`/`tokenUsage` 没有关系，所以必须单独带一份）。
   *
   * 没有线程（还没问过）时缺省。
   */
  context?: MicaBtwContext;
  /**
   * 排队等这一条答完的问题（见 `MicaBtwAskParams.queue`）。
   *
   * 只有一格：面板据此显示「排队中」，答完自动接上、撤回后字段消失。
   */
  pendingQuestion?: string;
};

/**
 * By The Way 线程的上下文占用。
 *
 * 口径与主对话状态栏一致：`tokens` 是**最近一次请求的上下文占用**
 * （`lastUsage.inputTokens`），而不是累计值——累计值会随轮次线性上涨，看不出
 * 「这一条线程还有多少余量」。压缩之后到下一次请求之前，`tokens` 换成压缩的估算值
 * 并置 `estimated: true`（否则界面会一直停在压缩前那个数字）。
 */
export type MicaBtwContext = {
  model?: string;
  effort?: string;
  providerId?: string;
  /** 最近一次请求的上下文占用（压缩后未再请求时是估算值）。 */
  tokens?: number;
  /** `tokens` 是不是压缩后的估算（还没被真实请求刷新）。 */
  estimated?: boolean;
  /** 最近一次请求里命中的缓存前缀 token 数。 */
  cachedTokens?: number;
  /** 模型的上下文窗口。 */
  contextWindowSize?: number;
  /** 本线程累计请求数。 */
  requests: number;
  /** 本线程累计 input/output token（用于提示「这条线程一共花了多少」）。 */
  totalInputTokens: number;
  totalOutputTokens: number;
};

/** `MICA_BTW_NOTIFICATIONS.updated` 的 payload。 */
export type MicaBtwThreadUpdated = MicaBtwThread & {
  /** 会话 id（其余 Mica 通知同款字段），客户端据此把线程归到对应会话。 */
  threadId?: string;
};

/**
 * Settings + per-session run counters for automatic compaction. Sent by the
 * client on `turn/start` / `mica/turn/editMessage` (the resident host is
 * spawned once, so the user's panel changes can only reach it per turn) and
 * echoed back — counters only — in `MICA_AUTO_COMPACT_NOTIFICATIONS.updated`.
 *
 * Semantics: 快速压缩 is the cheap local pass (no model request) and always
 * goes first — 模型压缩 is only reached after it, or directly once the quick
 * allowance is used up. So 快速压缩 runs when ctx ≥ `quickThresholdK` (or when
 * 模型压缩 is due) and it already ran fewer than `quickLimit` times; 模型压缩
 * runs when the context is *still* ≥ `modelThresholdK` (which is why the
 * default 120 is BELOW the quick threshold 200) and it already ran fewer than
 * `modelLimit` times.
 *
 * `minIntervalMs` throttles the two passes: a compaction needs to be at least
 * that far from the previous one (`lastRunAt`, carried along with the counters)
 * unless the context already reached the model threshold — that pass's quick →
 * model chain is one trigger, not two.
 */
export type MicaAutoCompactParams = {
  enabled?: boolean;
  quickThresholdK?: number;
  quickLimit?: number;
  quickRuns?: number;
  modelThresholdK?: number;
  modelLimit?: number;
  modelRuns?: number;
  minIntervalMs?: number;
  lastRunAt?: string | null;
};

/** `MICA_AUTO_COMPACT_NOTIFICATIONS.updated` payload. */
export type MicaAutoCompactStatus = {
  threadId?: string;
  quickRuns: number;
  modelRuns: number;
  lastRunAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
  lastNote: string | null;
};

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
 * - `mica/btw/ask`: By The Way（CLI 的 `/btw`）。收下问题立刻返回，答案走
 *   `MICA_BTW_NOTIFICATIONS.updated`——见那里的说明（同步等会把 interrupt/steer
 *   一起堵住）。
 * - `mica/session/rename`: the resident host owns the session file and writes it
 *   from its in-memory snapshot, so renaming while a turn runs (or while the host
 *   is merely idle but still alive) has to go through it — a client-side
 *   read-modify-write would be overwritten by the host's next save.
 * - `mica/btw/compact`: the By The Way thread is a reusable subagent living in the
 *   host, so its own history can only be shrunk there. Local only (`toolResultsOnly`
 *   semantics): no model request, no round dropped, repeatable.
 * - `mica/btw/threads` / `mica/btw/close`: the drawer's tabs are host-side threads
 *   (each with its own subagent), so listing them after a reload and closing one can
 *   only go through the host.
 *
 * Codex clients never send them; the host answers unknown methods with
 * method-not-found, so a Codex driver is unaffected.
 */
export const MICA_METHODS = {
  editMessage: 'mica/turn/editMessage',
  /** Pull a queued (after_iteration) input back out of the host's single slot
   * so the client can restore it to its composer — the CLI's shift + ←. */
  queueRecall: 'mica/queue/recall',
  /**
   * Freeze the queued input so an iteration boundary cannot inject it while the
   * client moves it back into the composer. Without it, clicking "re-edit" on a
   * queued message races the boundary and sends the text the user is editing.
   * `held: false` releases the hold (`params: { clientMessageId, held }`).
   */
  queueHold: 'mica/queue/hold',
  killBackgroundTask: 'mica/backgroundTasks/kill',
  backgroundTaskOutput: 'mica/backgroundTasks/output',
  subagentTaskDetail: 'mica/subagentTasks/detail',
  killSubagentTask: 'mica/subagentTasks/kill',
  btwAsk: 'mica/btw/ask',
  btwCompact: 'mica/btw/compact',
  /**
   * 停止正在回答的那一问（面板输入条的停止按钮）。
   *
   * 与 `btwAsk` 一样是**能打断的请求**：主流程在跑也要能调，所以 handler 不能等回答结束。
   */
  btwInterrupt: 'mica/btw/interrupt',
  /** Take the queued question back out of the slot (the drawer's queue ✕). */
  btwRecall: 'mica/btw/recall',
  /** List the session's By The Way threads (one per drawer tab) with their transcripts. */
  btwThreads: 'mica/btw/threads',
  /** Close one By The Way thread (the drawer's tab ✕). Refused while it is answering. */
  btwClose: 'mica/btw/close',
  renameSession: 'mica/session/rename',
} as const;

export type MicaBtwAskParams = {
  /**
   * 问题。留空表示「只建这条线程」——面板点 `+` 开一个新 tab 时会把 id 先拿到手，
   * 上下文要等第一次提问才取（这样空 tab 不会被算成一次问答）。
   */
  question?: string;
  /**
   * 要续问的线程（同一个 tab 里追问 = CLI 的 `/btw -continue`）。
   *
   * 不传就是**新开一条线程**（面板上的 `+`）。带了但 host 里没有这条（重启过、
   * 或者已经被淘汰）时按同一个 id 重建，客户端不必自己处理「线程丢了」。
   */
  threadId?: string;
  /**
   * 这条线程还在回答时排队等它答完（面板回答期间按 Enter/Tab）。
   *
   * 不带它就是「在跑就拒绝」：btw 复用同一个子代理，消息数组不是并发安全的，
   * 所以只有单槽位排队这一条路，不会并发开两次提问。
   */
  queue?: boolean;
};

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

/**
 * One `wait_for` call that is still waiting (see
 * `packages/mica-tools/waitFor/registry.ts`). The record lives in the host
 * process, so this snapshot is the only way the desktop app can show what a
 * turn is blocked on — a long wait otherwise looks like a frozen tool row.
 * `status` is `waiting` when a call is currently blocked on it and `parked`
 * when it was registered with `background: true` and nobody is polling yet.
 */
export type MicaWaitTaskItem = {
  id: string;
  kind: 'task' | 'process' | 'file' | 'command' | 'http' | 'port' | 'duration';
  /** Human-readable condition, e.g. `/tmp/out.txt changed`. */
  label: string;
  /**
   * Optional one-line reason for the wait (`wait_for`'s `reason`), shown on the
   * dock row ahead of `label` — a `duration` wait's label is just "等待 50s"
   * and says nothing about why the turn is waiting.
   */
  reason?: string;
  status: 'waiting' | 'parked';
  startedAt: string;
  /** Polls made so far; cheap progress signal for a long wait. */
  polls: number;
  /** Latest observation (or the latest poll error). */
  detail?: string;
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
