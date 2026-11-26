import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import { describeRequestError, REQUEST_MAX_RETRIES } from '@packages/mica-agent/core/retry.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { HookRegistry } from '@packages/mica-plugin/index.js';
import { micaRuntime, type MessageQueueService, type RuntimeInput } from '@packages/mica-runtime/index.js';
import type { SessionTurnLease } from '@packages/mica-session/index.js';
import { parseImageRefs } from '@packages/mica-ui/utils/imagePaste.js';
import type { SessionController } from '../session/SessionController.js';
import { AgentAbortError, type AgentRuntime } from '../agent/AgentRuntime.js';
import type { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import { uncommittedResponseText } from './conversationHistory.js';
import {
  TurnNoticeLog,
  createRetryFailedNotice,
  createRetryNotice,
  createRetryRecoveredNotice,
  createTurnErrorNotice,
  mergeInFlightUserMessage,
  type NoticeUpsertOptions,
  type TurnNotice,
} from './turnNotices.js';
import { compactIdleSessionHistory } from '../agent/agentCompaction.js';
import type { PluginTurnPrepareEvent } from '@packages/mica-plugin/index.js';
import { readPromptControls } from '@packages/mica-config/promptControls.js';

export type HeadlessTurnStatus = 'completed' | 'aborted' | 'error';

/** One shared, idempotent terminal path for a started turn. */
type TurnFinalization = {
  readonly status: HeadlessTurnStatus | null;
  finish(status: HeadlessTurnStatus, error?: unknown, inFlightUser?: InFlightUserMessage): Promise<HeadlessTurnStatus>;
};

/**
 * `busy-remote`: another process (a second app-server, the desktop chat host or a
 * TUI terminal) holds this session's turn lease, so this turn must not run.
 */
export type HeadlessTurnStartResult = 'started' | 'queued' | 'rejected' | 'busy-remote';

export type HeadlessTurnEvent =
  | { type: 'turn:start'; input: RuntimeInput }
  | { type: 'turn:finish'; input: RuntimeInput; status: HeadlessTurnStatus; elapsedMs: number; error?: string }
  | { type: 'turn:retrying'; input: RuntimeInput; attempt: number; maxAttempts: number; delayMs: number; error?: string }
  | { type: 'queued'; input: RuntimeInput; position: number; pending: RuntimeInput[] }
  | { type: 'dequeue'; input: RuntimeInput }
  | { type: 'queue:changed'; pending: RuntimeInput[] };

/** Shown when the session is running somewhere else (another window or terminal). */
export const REMOTE_TURN_MESSAGE = '该会话正在另一个窗口或终端运行，请等待完成后再发送';

export type HeadlessTurnExecutorOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  onEvent: (event: HeadlessTurnEvent) => void;
  /** Apply settings belonging to this input after the leased session is refreshed. */
  applyInputSettings?: (input: RuntimeInput) => void;
  /** Fired once the drain loop empties (all queued turns finished). */
  onIdle?: () => void;
  maxTurns?: number;
  parseImageRefs?: (text: string) => Promise<AgentQueryContent>;
  /**
   * Optional plugin layer: when set, the executor fires the same turn hooks as
   * the interactive runtime (input:received guard, turn:before, prompt:build,
   * turn:beforePersist, turn:error/abort, turn:after) and shares the plugin
   * host's single-slot queue, so plugins (session-autonomy, message-queue,
   * todo) behave identically in headless mode.
   */
  hooks?: HookRegistry;
  /** Object surfaced to hooks as `runtime` (needs getCurrentSessionId). */
  host?: { getCurrentSessionId(): string };
  queue?: MessageQueueService;
  /**
   * Persisted UI conversation messages (undefined falls back to
   * agent-derived). `extra` are messages of the current turn that are not in
   * the provider history yet (the in-flight prompt).
   */
  getConversationMessages?: (extra?: MicaUiConversationMessage[]) => MicaUiConversationMessage[] | undefined;
  /** Set to false to skip session persistence entirely (e.g. one-shot UI tasks). */
  save?: boolean;
  /**
   * 这一轮结束时收尾它起的后台子代理。
   *
   * 不注入就不会收尾（`mica exec --no-save` 这类没有插件层的运行连 `agent` 工具
   * 都不存在，也就不会有子代理）。
   */
  subagentTasks?: Pick<SubagentTaskManager, 'killRunningForOwner'>;
  /**
   * Session notices (retry hints, failure reasons) shown in the conversation
   * but kept out of the provider history. Attached with the plugin layer: the
   * plugin host owns the session-facing state.
   */
  notices?: HeadlessNoticeSource;
};

export type HeadlessNoticeSource = {
  /** Rebinds to the live session (a resume rebuilds it from the session file). */
  ensure(): TurnNoticeLog;
  /**
   * 落盘并推给正在看的客户端（常驻宿主才有）。写进去的 notice 只是会话记录的一部分，
   * 就地改写（重试中 → 重试成功）必须同时通知客户端，否则屏幕上那条要等到重新打开
   * 会话才会变。
   */
  show?: (notice: TurnNotice, options?: NoticeUpsertOptions) => void;
};

/**
 * UI-agnostic turn executor shared by the per-session chat host (`mica
 * app-server`) and `mica exec`. Implements
 * the same single-slot message queue and after_iteration iteration-boundary
 * injection as the interactive runtime, minus all Ink/UI coupling:
 *
 * - one agent runs one turn at a time; while busy, new inputs are queued
 *   (after_iteration inputs are injected at a completed tool iteration,
 *   after_turn inputs start once the current turn ends);
 * - turn lifecycle is reported through `onEvent` — every turn, including
 *   queued ones drained after the first, emits `turn:start` + `turn:finish`;
 *   streamed text/tool/usage stays on the consumer side (CodexProjector or a
 *   caller's event sink), so this class never owns an output protocol;
 * - a queued input is only run once the turn before it completed; an aborted or
 *   failed turn leaves it in the queue (same rule as the message-queue plugin's
 *   turn:after and the interactive runtime), so the user can still recall it
 *   instead of watching a stopped turn hand its queued text to a fresh run.
 *
 * When a plugin layer is attached, the turn hooks mirror the interactive
 * runtime's ordering: input:received guard on submit, turn:before +
 * prompt:build before agent.run, turn:beforePersist before the completed
 * save, turn:abort / turn:error on failures, turn:after once the turn
 * finished. One-shot headless runs additionally re-emit a final turn:before
 * after the queue empties, so turn:before work still runs when the last turn
 * never produced a turn:after.
 */
export class HeadlessTurnExecutor {
  private options: HeadlessTurnExecutorOptions;
  private queue: MessageQueueService;
  private readonly parseImageRefs: (text: string) => Promise<AgentQueryContent>;
  private running = false;
  private responseBuffer = '';
  /**
   * The part of `responseBuffer` already committed to the provider history at
   * the last iteration boundary. An aborted turn must only append the remainder
   * (`uncommittedResponseText`); passing the whole buffer duplicates the text
   * that a completed tool iteration already persisted.
   */
  private committedResponseBuffer = '';
  private lease: SessionTurnLease | null = null;
  /** Independent of AgentRuntime.runId, which refresh/prepare can replace. */
  private activeTurnCancellation: AbortController | null = null;
  /**
   * 轮次之外改会话文件的任务（插件触发的空闲压缩）。与 turn 互斥：它在跑的时候
   * `start()` 先等它收尾，它在 `start()` 已经开始之后就不再接受新任务。
   */
  private idleTask: Promise<unknown> | null = null;
  private starting = false;
  /**
   * 本轮最近一次重试。失败的那条提示是在重试之前写下的，得有人负责收尾：重试之后的
   * 那次请求跑通了，就把它改写成「重试成功」，否则一条红条会让成功的回合看起来是坏的。
   */
  private pendingRetry: { attempt: number; maxAttempts: number; error: unknown } | null = null;
  constructor(options: HeadlessTurnExecutorOptions) {
    this.options = options;
    options.sessionController.setTodoPersistenceEnabled?.(options.save !== false);
    this.queue = options.queue ?? new micaRuntime.MessageQueueService();
    this.parseImageRefs = options.parseImageRefs ?? parseImageRefs;
  }

  get isBusy(): boolean {
    return this.running;
  }

  get pendingInputs(): RuntimeInput[] {
    return this.queue.list();
  }

  /**
   * Whether this executor owns the session file. One-shot tasks
   * (`save: false`) never persist, so they neither take the turn lease nor can
   * be blocked by someone else holding it.
   */
  private get persistsSession(): boolean {
    return this.options.save !== false;
  }

  /**
   * Binds the plugin layer after construction. The plugin host needs this
   * executor for its submit/queue bridges while the executor needs the host's
   * hooks/queue, so one side must attach late.
   */
  attachPluginLayer(layer: {
    hooks: HookRegistry;
    host: { getCurrentSessionId(): string };
    queue: MessageQueueService;
    getConversationMessages: (extra?: MicaUiConversationMessage[]) => MicaUiConversationMessage[] | undefined;
    notices?: HeadlessNoticeSource;
  }): void {
    if (this.options.hooks) throw new Error('plugin layer already attached');
    this.options = { ...this.options, ...layer };
    // The plugin host owns the shared single-slot queue; switch to it so
    // plugin-enqueued inputs (message-queue after_turn/after_iteration) are
    // drained by this loop instead of being stranded in a second queue.
    this.queue = layer.queue;
  }

  async start(input: RuntimeInput): Promise<HeadlessTurnStartResult> {
    // 先让轮次之外的那次改写收尾：它持有 turn lease，抢在前面取锁只会让用户看到
    // 「该会话正在另一个窗口运行」，而这里明明是同一个进程。
    this.starting = true;
    try {
      if (this.idleTask) await this.idleTask;
      return await this.startTurn(input);
    } finally {
      this.starting = false;
    }
  }

  private async startTurn(input: RuntimeInput): Promise<HeadlessTurnStartResult> {
    if (this.options.hooks) {
      const guardResult = await this.options.hooks.guard('input:received', {
        input,
        isCommand: false,
        owner: this.options.agent,
      });
      // The message-queue plugin takes over queueing while busy; never let the
      // input fall through to the executor's own queue or it would be enqueued
      // twice (once by the plugin, once here) and dropped on dequeue.
      if (guardResult.handled || guardResult.blocked) {
        if (guardResult.handled) {
          this.options.onEvent({
            type: 'queued',
            input,
            position: this.queue.count(),
            pending: this.queue.list(),
          });
        }
        return guardResult.blocked ? 'rejected' : 'queued';
      }
    }
    if (this.running) {
      if (!this.queue.enqueue(input)) return 'rejected';
      this.options.onEvent({ type: 'queued', input, position: this.queue.count(), pending: this.queue.list() });
      return 'queued';
    }
    // Take the cross-process lease before the turn is announced: refusing here
    // lets the client roll the optimistic message back instead of discovering
    // the conflict halfway through a turn.
    const cancellation = new AbortController();
    this.activeTurnCancellation = cancellation;
    const lease = this.acquireTurnLease();
    if (this.persistsSession && !lease) {
      if (this.activeTurnCancellation === cancellation) this.activeTurnCancellation = null;
      return 'busy-remote';
    }
    this.lease = lease;
    this.running = true;
    this.options.onEvent({ type: 'turn:start', input });
    void this.loop(input, cancellation);
    return 'started';
  }

  /**
   * 在轮次之外独占一次会话，让调用方改它（自动压缩用它把历史压小）。
   *
   * 拿不到独占权时返回 `busy`（调用方给的值），这不是错误：这一轮正在跑、另一个进程
   * （另一个窗口 / 终端）持有 turn lease、或者刚好有人按了发送（`starting`）。调用方
   * 据此「这次没做」，不要重试、也不要当成失败——但要把原因说出来，否则用户和日志都
   * 分不清「没得做」和「做不上」。
   */
  async runIdleMaintenance<T>(task: () => Promise<T>, busy: T): Promise<T> {
    if (this.running || this.starting) return busy;
    // 同一时刻只做一次：第二次触发直接当成「这次没做」，不排队也不合并两个任务。
    if (this.idleTask) return busy;
    const run = (async (): Promise<T> => {
      const lease = this.acquireTurnLease();
      if (this.persistsSession && !lease) return busy;
      try {
        // 另一个宿主可能在我们上次保存之后写过这条会话：先对齐磁盘，否则这次压缩
        // 会把它那一轮覆盖掉。
        this.options.sessionController.refreshFromStore();
        return await task();
      } finally {
        try {
          lease?.release();
        } catch {
          // 释放是尽力而为；孤儿锁由 pid 存活判定回收。
        }
      }
    })();
    this.idleTask = run;
    try {
      return await run;
    } finally {
      if (this.idleTask === run) this.idleTask = null;
    }
  }

  /**
   * Stops the active turn. A queued input is *not* sent afterwards: it stays in
   * the queue (recallable) until a turn actually completes.
   */
  abort(): void {
    this.activeTurnCancellation?.abort();
    this.options.agent.abort();
  }

  /**
   * Pulls the queued input back out so the caller can restore it to the input
   * box (`mica/queue/recall` mirrors the CLI's shift + ←). Returns the removed
   * input, or null when it is gone (already injected / mismatched id).
   */
  recall(clientMessageId?: string): RuntimeInput | null {
    const [pending] = this.queue.list();
    if (!pending) return null;
    if (clientMessageId && pending.id !== clientMessageId) return null;
    const removed = this.queue.removeLast();
    if (!removed) return null;
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    return removed;
  }

  /**
   * Freeze the queued input for `hold` (or unfreeze it for `release`). The
   * desktop app holds a queued message while it pulls it back into the composer,
   * so an iteration boundary cannot inject the text the user is re-editing.
   * Returns false when the slot no longer holds that id — already injected or
   * recalled, i.e. the client was too late.
   */
  holdQueued(clientMessageId: string | undefined, held: boolean): boolean {
    return held ? this.queue.holdQueued(clientMessageId) : this.queue.releaseQueued(clientMessageId);
  }

  private async loop(firstInput: RuntimeInput, firstCancellation: AbortController): Promise<void> {
    let input: RuntimeInput | null = firstInput;
    let first = true;
    while (input) {
      const cancellation = first ? firstCancellation : new AbortController();
      this.activeTurnCancellation = cancellation;
      // `start()` announced the first turn; every drained turn needs its own
      // turn:start too, otherwise consumers that map the event to a per-turn
      // lifecycle (app-server turn/started) never
      // learn that the executor is still working on a queued input.
      if (!first) this.options.onEvent({ type: 'turn:start', input });
      // Each turn owns a fresh lease; the previous one was released before its
      // turn:after (see releaseTurnLease), so a queued input never inherits a
      // stale lock.
      const lease = first ? this.lease : this.acquireTurnLease();
      first = false;
      let status: HeadlessTurnStatus = 'error';
      if (this.persistsSession && !lease) {
        // Another window/terminal claimed this session between our turns. The
        // queued input cannot run without writing a file someone else is
        // editing, so fail that turn instead of racing it. turn:start was
        // emitted above so the client receives a matching turn/completed
        // (failed) rather than a turn it never hears about.
        this.options.onEvent({
          type: 'turn:finish',
          input,
          status: 'error',
          elapsedMs: 0,
          error: REMOTE_TURN_MESSAGE,
        });
      } else {
        this.lease = lease;
        const finalization = this.createTurnFinalization(input);
        try {
          status = await this.runTurn(input, finalization, cancellation.signal);
        } catch (error) {
          // runTurn normally settles itself.  A failing terminal hook/event is
          // already finalized, so this guard must never emit a second finish.
          if (finalization.status === null) {
            try {
              await finalization.finish(cancellation.signal.aborted ? 'aborted' : 'error', error);
            } catch {
              // finish always attempts the terminal event, even if a hook fails.
            }
          }
          status = finalization.status ?? 'error';
        } finally {
          this.releaseTurnLease();
        }
      }
      if (this.activeTurnCancellation === cancellation) this.activeTurnCancellation = null;
      // 排队输入只在一轮**真的完成**之后才接着跑（message-queue 插件与交互式
      // runtime 的 turn:after 同一条规则）。失败/中止时把它留在队列里：还在排队、
      // 用户仍能撤回，而不是「点了停止之后排队的那条又被偷偷送出去跑一轮」。
      if (status !== 'completed' || cancellation.signal.aborted) break;
      input = this.queue.dequeue();
      if (input) this.options.onEvent({ type: 'dequeue', input });
    }
    this.releaseTurnLease();
    this.running = false;
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    this.options.onIdle?.();
  }

  /**
   * The turn lease is the cross-process fact that a session is being written by
   * a live turn (see `packages/mica-session/sessionStore.ts`). The interactive
   * runtime takes it in `LocalRuntimeController.submit`; headless hosts
   * (app-server for the desktop/web chat, `mica exec`) must do the same,
   * otherwise `turnState: "running"` sits on disk with nobody holding the lock,
   * and another client cannot tell a live turn from crash residue.
   */
  private acquireTurnLease(): SessionTurnLease | null {
    if (!this.persistsSession) return null;
    return this.options.sessionController.acquireTurnLease();
  }

  private releaseTurnLease(): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = null;
    try {
      lease.release();
    } catch {
      // Release is best effort; the orphan lock is reclaimed by pid liveness.
    }
  }

  private createTurnFinalization(input: RuntimeInput): TurnFinalization {
    const startedAt = Date.now();
    let status: HeadlessTurnStatus | null = null;
    let completion: Promise<HeadlessTurnStatus> | null = null;
    return {
      get status() { return status; },
      finish: (outcome, error, inFlightUser) => {
        if (completion) return completion;
        status = outcome;
        completion = (async () => {
          let terminalStatus = outcome;
          let terminalError = error;
          try {
            this.saveCurrent({ turnState: outcome }, inFlightUser);
          } catch (saveError) {
            // Do not announce a successful turn when its terminal save failed.
            terminalStatus = 'error';
            status = terminalStatus;
            terminalError = saveError;
          }
          try {
            // This also releases the lease and settles subagents without a
            // plugin layer; turn:finish must follow it even when a hook throws.
            await this.emitTurnAfter(input, terminalStatus, Date.now() - startedAt, terminalStatus === 'error');
          } finally {
            this.options.onEvent({
              type: 'turn:finish',
              input,
              status: terminalStatus,
              elapsedMs: Date.now() - startedAt,
              ...(terminalError === undefined
                ? {}
                : { error: terminalError instanceof Error ? terminalError.message : String(terminalError) }),
            });
          }
          return terminalStatus;
        })();
        return completion;
      },
    };
  }

  private throwIfTurnStopped(signal: AbortSignal, runId?: number): void {
    if (signal.aborted || (runId !== undefined && !this.options.agent.isCurrent(runId))) {
      throw new AgentAbortError(runId);
    }
  }

  private async runTurn(input: RuntimeInput, finalization: TurnFinalization, signal: AbortSignal): Promise<HeadlessTurnStatus> {
    const { agent, onEvent } = this.options;
    this.responseBuffer = '';
    this.committedResponseBuffer = '';
    let content: AgentQueryContent = runContentOr(input);
    // 除了 `system`（提示词内部注入，用户从没打过这句话）之外都要留下用户消息：
    // 插件提交的一轮（`ctx.runtime.submit`）在客户端没有乐观气泡，不写进去就只剩回答，
    // 会话记录里看不到「这一轮是为什么跑起来的」。`displayText` 优先——插件可以给一句
    // 短标题，而真正发给模型的提示词可能很长。
    let inFlightUser: InFlightUserMessage | undefined =
      input.source === 'system'
        ? undefined
        : { message: { role: 'user', content: displayUserContent(input, content) }, rawContent: content };
    try {
      // Refresh the persisted signature before this turn's saves: another host
      // (a second app-server for the same session or a CLI
      // resume) may have written the session file since our last save. Without
      // this, saveCurrent's "another process wrote" guard would skip every
      // save of this turn and the conversation would be lost on restart.
      // Must run before reserveRunId(): loadSnapshot inside the refresh bumps
      // the run id, and reserving first would make this turn look aborted.
      this.options.sessionController.refreshFromStore();
      this.throwIfTurnStopped(signal);
      content =
        input.content !== undefined
          ? (input.content as AgentQueryContent)
          : input.source === 'system'
            ? input.text
            : await this.parseImageRefs(input.text);
      this.throwIfTurnStopped(signal);
      if (inFlightUser) inFlightUser = { message: { role: 'user', content: displayUserContent(input, content) }, rawContent: content };
      const before = this.persistsSession && this.options.hooks ? agent.getSnapshot() : null;
      this.options.applyInputSettings?.(input);
      this.throwIfTurnStopped(signal);
      if (before && this.options.hooks) {
        const current = agent.getSnapshot();
        const usage = before.lastUsage;
        const event: PluginTurnPrepareEvent = {
          previous: {
            providerId: usage?.providerId ?? before.providerId,
            model: usage?.model ?? before.model,
            effort: before.effort,
          },
          current: { providerId: current.providerId, model: current.model, effort: current.effort },
          compactHistory: async (options) => {
            this.throwIfTurnStopped(signal);
            const result = await compactIdleSessionHistory({
              agent,
              sessionController: this.options.sessionController,
              // 与轮次之外那条手动通路同一份展示记录：provider 投影 + 会话 notice。
              // 只写投影会把 notice（重试提示、命令结果、插件提问）从这次落盘里抹掉，
              // 而它们要等的下一轮保存才回来——中途崩溃就真丢了。
              conversationMessages: () =>
                this.options.getConversationMessages?.() ?? agent.toConversationMessages(),
              ...options,
            });
            this.throwIfTurnStopped(signal);
            return result ? { status: 'applied', ...result } : { status: 'skipped', reason: 'empty' };
          },
        };
        await this.options.hooks.emit('turn:prepare', event);
      }
      this.throwIfTurnStopped(signal);
      const reservedRunId = agent.reserveRunId();
      this.throwIfTurnStopped(signal, reservedRunId);
      this.saveCurrent({ allowEmpty: true, turnState: 'running' }, inFlightUser);
      let runContent = content;
      if (this.options.hooks) {
        await this.options.hooks.emit('turn:before', { runtime: this.options.host, owner: agent, input, content });
        this.throwIfTurnStopped(signal, reservedRunId);
        const promptBuildEvent = await this.options.hooks.pipeline('prompt:build', {
          runtime: this.options.host,
          input,
          content,
        });
        this.throwIfTurnStopped(signal, reservedRunId);
        if (promptBuildEvent?.content !== undefined) runContent = promptBuildEvent.content;
      }
      this.throwIfTurnStopped(signal, reservedRunId);
      let attemptStartBuffer = this.responseBuffer;
      const text = (chunk: string) => {
        this.responseBuffer += chunk;
      };
      const start = () => {
        attemptStartBuffer = this.responseBuffer;
      };
      const rollback = () => {
        this.responseBuffer = attemptStartBuffer;
      };
      agent.events.on('text', text);
      agent.events.on('textAttemptStart', start);
      agent.events.on('textRollback', rollback);
      const unregisterRollback = agent.registerTextRollbackConsumer({ text, start, rollback });
      try {
        const promptControls = readPromptControls();
        this.pendingRetry = null;
        const runResult = await agent.run(runContent, {
          reservedRunId,
          promptControls,
          maxTurns: this.options.maxTurns,
          onIterationComplete: () => {
            this.saveCurrent({ allowEmpty: true, turnState: 'running' });
            // The iteration that just completed pushed its text (and tool
            // results) into the provider history: everything streamed so far
            // is committed, so an abort from here on only owes the remainder.
            this.committedResponseBuffer = this.responseBuffer;
            if (signal.aborted || !agent.isCurrent(reservedRunId)) return null;
            return this.takeQueuedIterationInput();
          },
          // 请求级重试是这条路径上唯一的重试层：它只重发当前这条请求，已经跑过的工具
          // 不重放，所以跑过写操作也不影响。每次重发都落一条 notice 并通知客户端，
          // 桌面端据此显示「第 n/10 次 · 原因」。
          onRetry: (info) => {
            if (signal.aborted || !agent.isCurrent(reservedRunId)) return;
            this.pendingRetry = { attempt: info.attempt, maxAttempts: REQUEST_MAX_RETRIES, error: info.error };
            try {
              this.writeNotice(createRetryNotice(info.error, info.attempt, REQUEST_MAX_RETRIES, info.delayMs));
              this.saveCurrent({ allowEmpty: true, turnState: 'running' }, inFlightUser);
            } catch {
              // 诊断性质的 notice 不能把一次还能重试的请求变成失败。
            }
            onEvent({
              type: 'turn:retrying',
              input,
              attempt: info.attempt,
              maxAttempts: REQUEST_MAX_RETRIES,
              delayMs: info.delayMs,
              error: describeRequestError(info.error),
            });
          },
          // 重试后的那次请求收尾时才知道它到底通没通：那条红字提示要在这里转绿。
          onRequestEnd: (info) => {
            if (info.outcome === 'completed') this.settleRetryNotice();
          },
        });
        // A resolved query has committed its final response as well as its
        // tool iterations.  If abort invalidates the result before persistence,
        // preserveAbortedTurn must not append that response a second time.
        this.committedResponseBuffer = this.responseBuffer;
        if (signal.aborted || !agent.isCurrent(runResult.runId)) {
          // `agent.run()` can resolve after an abort has invalidated its run id.
          // Route that stale resolution through the same abort finalization as a
          // rejected AgentAbortError; returning here leaves the persisted turn
          // running and skips turn:after/turn:finish.
          throw new AgentAbortError(runResult.runId);
        }
        if (this.options.hooks) {
          await this.options.hooks.emit('turn:beforePersist', {
            runtime: this.options.host,
            input,
            content: runContent,
            result: runResult,
          });
        }
        this.throwIfTurnStopped(signal, runResult.runId);
        return await finalization.finish('completed', undefined, inFlightUser);
      } finally {
        unregisterRollback();
        agent.events.off('text', text);
        agent.events.off('textAttemptStart', start);
        agent.events.off('textRollback', rollback);
      }
    } catch (error) {
      // A terminal hook/event can throw after the save/after/finish path was
      // claimed.  Never reinterpret it as a second turn failure.
      if (finalization.status !== null) return finalization.status;
      if (signal.aborted || error instanceof AgentAbortError) {
        try {
          if (this.options.hooks) {
            await this.options.hooks.emit('turn:abort', { runtime: this.options.host, input, content, error });
          }
          agent.preserveAbortedTurn(
            runContentOr(input),
            uncommittedResponseText(this.responseBuffer, this.committedResponseBuffer) || undefined,
          );
        } finally {
          await finalization.finish('aborted', undefined, inFlightUser);
        }
        return finalization.status ?? 'aborted';
      }
      if (this.options.hooks) {
        await this.options.hooks.emit('turn:error', { runtime: this.options.host, input, content, error });
      }
      return this.failTurn(input, finalization, error, inFlightUser);
    }
  }

  private async failTurn(
    input: RuntimeInput,
    finalization: TurnFinalization,
    error: unknown,
    inFlightUser?: InFlightUserMessage,
  ): Promise<HeadlessTurnStatus> {
    this.options.agent.preserveAbortedTurn(
      runContentOr(input),
      uncommittedResponseText(this.responseBuffer, this.committedResponseBuffer) || undefined,
    );
    // The turn-level error becomes part of the conversation, not just of the
    // transient Codex `turn/completed.status=failed` payload: the desktop app
    // used to lose it on reload. Notices stay out of the provider history.
    //
    // 这一轮里最后一次请求是重试耗尽的，就把那条「将在 Ns 后重试」就地改成结论：
    // 次数与最后一次失败原因留在同一行，不另起一条看起来像第二件事的 `/error`。
    const retry = this.pendingRetry;
    this.pendingRetry = null;
    this.writeNotice(
      retry
        ? createRetryFailedNotice(error, retry.attempt, retry.maxAttempts)
        : createTurnErrorNotice(error),
      retry ? { inPlace: true } : {},
    );
    return finalization.finish('error', error, inFlightUser);
  }

  /**
   * 写一条会话 notice。常驻宿主会顺手推给客户端（`show`），`mica exec` 这类没有
   * 客户端的地方只落盘。
   */
  private writeNotice(notice: TurnNotice, options: NoticeUpsertOptions = {}): void {
    const notices = this.options.notices;
    if (!notices) return;
    // `--no-save` 不写会话文件，也就没有能推给客户端的那一份：只留在内存里。
    if (notices.show && this.persistsSession) notices.show(notice, options);
    else notices.ensure().upsert(notice, options);
  }

  /**
   * 重试后的那次请求跑通了：把「将在 Ns 后重试」就地改成「重试成功」。
   *
   * 位置不动（`inPlace`）——这条提示说的还是同一次重试，不该因为期间提交了正文就被
   * 挤到下面，读成「先失败后成功」的两件事。
   */
  private settleRetryNotice(): void {
    const retry = this.pendingRetry;
    if (!retry) return;
    this.pendingRetry = null;
    try {
      this.writeNotice(createRetryRecoveredNotice(retry.error, retry.attempt, retry.maxAttempts), { inPlace: true });
    } catch {
      // 与重试提示本身同理：诊断性质的 notice 不能把一次成功的回合变成失败。
    }
  }

  private async emitTurnAfter(
    input: RuntimeInput,
    outcome: 'completed' | 'aborted' | 'error',
    elapsedMs: number,
    hasError: boolean,
  ): Promise<void> {
    // The lease must be gone before turn:after: the message-queue plugin starts
    // the next turn from that hook, and a lease we still hold would make the
    // session look busy to its own process (the interactive runtime releases it
    // in the same place for the same reason).
    this.releaseTurnLease();
    // 放在 turn:after 之前：那个 hook 会启动排队的下一轮，下一轮开始时就该看不到
    // 这一轮的孤儿任务了。
    try {
      this.settleSubagents(outcome === 'aborted');
    } finally {
      await this.options.hooks?.emit('turn:after', {
        input,
        elapsedMs,
        hasError,
        outcome,
        owner: this.options.agent,
      });
    }
  }

  /**
   * 这一轮已经收尾，它起的后台子代理不会再有消费者：结果只能经 `agent
   * operation=read` 取回，而下一轮的模型不会去读上一个 turn 的 task_id。留着它们
   * 只会在状态栏挂一条永远 running 的条目，并继续烧 token。
   *
   * 幂等（只处理仍在跑的任务），且不发完成通知，所以重试、中止与排队轮次都不会
   * 因此多出一条系统消息。
   */
  private settleSubagents(interrupted = false): void {
    this.options.subagentTasks?.killRunningForOwner(
      this.options.agent,
      interrupted ? 'Parent turn was aborted.' : 'Parent turn finished.',
      {
        interrupted,
      },
    );
  }

  /**
   * `pendingUserMessage` carries the prompt of a turn that has not reached the
   * provider history yet (the turn-start / pre-retry save, before `agent.run`
   * appends it). Without it a turn killed during its first request persists a
   * conversation-less placeholder that the session list classifies as junk and
   * hides, so the session looks lost after an unexpected termination. The
   * interactive runtime persists the same in-flight message for its uiState.
   */
  private saveCurrent(
    options: {
      allowEmpty?: boolean;
      turnState: 'running' | 'completed' | 'aborted' | 'error';
    },
    inFlightUser?: InFlightUserMessage,
  ): void {
    if (this.options.save === false) return;
    // The in-flight prompt goes through the host's composer: notices created
    // for this turn must stay behind it, not in front of the user bubble.
    const hostMessages = this.options.getConversationMessages?.(inFlightUser ? [inFlightUser.message] : undefined);
    const conversationMessages = inFlightUser
      ? mergeInFlightUserMessage(
          hostMessages ?? [...this.options.agent.toConversationMessages(), inFlightUser.message],
          inFlightUser,
        )
      : hostMessages;
    this.options.sessionController.saveCurrent(conversationMessages ? { ...options, conversationMessages } : options);
  }

  private takeQueuedIterationInput(): Promise<AgentQueryContent | null> {
    const next = this.queue.dequeueAfterCompletedIteration(true);
    if (!next) return Promise.resolve(null);
    this.options.onEvent({ type: 'dequeue', input: next });
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    return next.source === 'system' ? Promise.resolve(next.text) : this.parseImageRefs(next.text);
  }
}

function runContentOr(input: RuntimeInput): AgentQueryContent {
  return (input.content as AgentQueryContent | undefined) ?? input.text;
}

/** 本轮的用户消息：`message` 是会话记录里展示的版本，`rawContent` 是真正发给模型的内容。 */
export type InFlightUserMessage = {
  message: MicaUiConversationMessage;
  rawContent: unknown;
};

/**
 * 会话记录里那条用户消息的内容。
 *
 * `displayText` 存在时用它（插件提交的提示词往往很长，界面上只需要一句「为什么跑这一轮」）；
 * 否则用本轮真正的输入内容，与客户端发起的轮次完全一致。
 */
export function displayUserContent(input: RuntimeInput, content: AgentQueryContent): string | AgentQueryContent {
  const display = typeof input.displayText === 'string' ? input.displayText.trim() : '';
  return display || content;
}

