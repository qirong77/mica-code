import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { HookRegistry } from '@packages/mica-plugin/index.js';
import { micaRuntime, type MessageQueueService, type RuntimeInput } from '@packages/mica-runtime/index.js';
import { parseImageRefs } from '@packages/mica-ui/utils/imagePaste.js';
import type { SessionController } from '../session/SessionController.js';
import { AgentAbortError, type AgentRuntime } from '../agent/AgentRuntime.js';

export type HeadlessTurnStatus = 'completed' | 'aborted' | 'error';

export type HeadlessTurnEvent =
  | { type: 'turn:start'; input: RuntimeInput }
  | { type: 'turn:finish'; input: RuntimeInput; status: HeadlessTurnStatus; elapsedMs: number; error?: string }
  | { type: 'queued'; input: RuntimeInput; position: number; pending: RuntimeInput[] }
  | { type: 'dequeue'; input: RuntimeInput }
  | { type: 'queue:changed'; pending: RuntimeInput[] };

export type HeadlessTurnExecutorOptions = {
  agent: AgentRuntime;
  sessionController: SessionController;
  onEvent: (event: HeadlessTurnEvent) => void;
  /** Fired once the drain loop empties (all queued turns finished). */
  onIdle?: () => void;
  maxTurns?: number;
  parseImageRefs?: (text: string) => Promise<AgentQueryContent>;
  /**
   * Optional plugin layer: when set, the executor fires the same turn hooks as
   * the interactive runtime (input:received guard, turn:before, prompt:build,
   * turn:beforePersist, turn:error/abort, turn:after) and shares the plugin
   * host's single-slot queue, so plugins (session-autonomy, message-queue,
   * context-pressure, todo) behave identically in headless mode.
   */
  hooks?: HookRegistry;
  /** Object surfaced to hooks as `runtime` (needs getCurrentSessionId). */
  host?: { getCurrentSessionId(): string };
  queue?: MessageQueueService;
  /** Persisted UI conversation messages (undefined falls back to agent-derived). */
  getConversationMessages?: () => MicaUiConversationMessage[] | undefined;
  /** Set to false to skip session persistence entirely (e.g. one-shot UI tasks). */
  save?: boolean;
};

/**
 * UI-agnostic turn executor shared by the per-session chat host (`mica
 * app-server`), `mica exec` and the sync daemon's CommandExecutor. Implements
 * the same single-slot message queue and after_iteration iteration-boundary
 * injection as the interactive runtime, minus all Ink/UI coupling:
 *
 * - one agent runs one turn at a time; while busy, new inputs are queued
 *   (after_iteration inputs are injected at a completed tool iteration,
 *   after_turn inputs start once the current turn ends);
 * - turn lifecycle is reported through `onEvent`; streamed text/tool/usage
 *   stays on the consumer side (CodexProjector or sync-event mapping), so
 *   this class never owns an output protocol;
 * - aborts stop the active turn but keep the queue draining, matching the
 *   desktop app's current abort-then-continue behavior.
 *
 * When a plugin layer is attached, the turn hooks mirror the interactive
 * runtime's ordering: input:received guard on submit, turn:before +
 * prompt:build before agent.run, turn:beforePersist before the completed
 * save, turn:abort / turn:error on failures, turn:after once the turn
 * finished. Pending plugin ops (e.g. session_compact) are applied by the
 * session-autonomy plugin in turn:after; one-shot headless runs additionally
 * re-emit a final turn:before after the queue empties as a fallback.
 */
export class HeadlessTurnExecutor {
  private options: HeadlessTurnExecutorOptions;
  private queue: MessageQueueService;
  private readonly parseImageRefs: (text: string) => Promise<AgentQueryContent>;
  private running = false;
  private responseBuffer = '';

  constructor(options: HeadlessTurnExecutorOptions) {
    this.options = options;
    this.queue = options.queue ?? new micaRuntime.MessageQueueService();
    this.parseImageRefs = options.parseImageRefs ?? parseImageRefs;
    options.agent.events.on('text', (text) => {
      this.responseBuffer += text;
    });
  }

  get isBusy(): boolean {
    return this.running;
  }

  get pendingInputs(): RuntimeInput[] {
    return this.queue.list();
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
    getConversationMessages: () => MicaUiConversationMessage[] | undefined;
  }): void {
    if (this.options.hooks) throw new Error('plugin layer already attached');
    this.options = { ...this.options, ...layer };
    // The plugin host owns the shared single-slot queue; switch to it so
    // plugin-enqueued inputs (message-queue after_turn/after_iteration) are
    // drained by this loop instead of being stranded in a second queue.
    this.queue = layer.queue;
  }

  async start(input: RuntimeInput): Promise<'started' | 'queued' | 'rejected'> {
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
    this.running = true;
    this.options.onEvent({ type: 'turn:start', input });
    void this.loop(input);
    return 'started';
  }

  /** Stops the active turn; queued inputs keep draining after it finishes. */
  abort(): void {
    this.options.agent.abort();
  }

  recall(clientMessageId?: string): boolean {
    const [pending] = this.queue.list();
    if (!pending) return false;
    if (clientMessageId && pending.id !== clientMessageId) return false;
    this.queue.removeLast();
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    return true;
  }

  private async loop(firstInput: RuntimeInput): Promise<void> {
    let input: RuntimeInput | null = firstInput;
    while (input) {
      try {
        await this.runTurn(input);
      } catch (error) {
        // runTurn handles abort/error itself; this guards the drain loop.
        if (this.options.hooks) await this.emitTurnAfter(input, 'error', 0, true);
        this.options.onEvent({
          type: 'turn:finish',
          input,
          status: 'error',
          elapsedMs: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      input = this.queue.dequeue();
      if (input) this.options.onEvent({ type: 'dequeue', input });
    }
    this.running = false;
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    this.options.onIdle?.();
  }

  private async runTurn(input: RuntimeInput): Promise<void> {
    const { agent, onEvent } = this.options;
    const startedAt = Date.now();
    this.responseBuffer = '';
    let content: AgentQueryContent;
    try {
      content =
        input.content !== undefined
          ? (input.content as AgentQueryContent)
          : input.source === 'system'
            ? input.text
            : await this.parseImageRefs(input.text);
    } catch (error) {
      await this.failTurn(input, startedAt, error);
      return;
    }
    try {
      // Refresh the persisted signature before this turn's saves: another host
      // (a second app-server for the same session, the sync daemon or a CLI
      // resume) may have written the session file since our last save. Without
      // this, saveCurrent's "another process wrote" guard would skip every
      // save of this turn and the conversation would be lost on restart.
      // Must run before reserveRunId(): loadSnapshot inside the refresh bumps
      // the run id, and reserving first would make this turn look aborted.
      this.options.sessionController.refreshFromStore();
      const reservedRunId = agent.reserveRunId();
      this.saveCurrent({ allowEmpty: true, turnState: 'running' });
      let runContent = content;
      if (this.options.hooks) {
        await this.options.hooks.emit('turn:before', { runtime: this.options.host, input, content });
        const promptBuildEvent = await this.options.hooks.pipeline('prompt:build', {
          runtime: this.options.host,
          input,
          content,
        });
        if (promptBuildEvent?.content !== undefined) runContent = promptBuildEvent.content;
      }
      const result = await agent.run(runContent, {
        reservedRunId,
        maxTurns: this.options.maxTurns,
        onIterationComplete: () => {
          this.saveCurrent({ allowEmpty: true, turnState: 'running' });
          return this.takeQueuedIterationInput();
        },
      });
      // An abort that lands between reserveRunId() and the agent.run() check is
      // surfaced by agent.run() as an AgentAbortError below; never return here
      // silently or the client never receives a turn/completed notification and
      // the app stays "running" forever.
      if (!agent.isCurrent(result.runId)) return;
      if (this.options.hooks) {
        await this.options.hooks.emit('turn:beforePersist', {
          runtime: this.options.host,
          input,
          content: runContent,
          result,
        });
      }
      this.saveCurrent({ turnState: 'completed' });
      if (this.options.hooks) await this.emitTurnAfter(input, 'completed', Date.now() - startedAt, false);
      onEvent({ type: 'turn:finish', input, status: 'completed', elapsedMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        if (this.options.hooks) {
          await this.options.hooks.emit('turn:abort', { runtime: this.options.host, input, content, error });
        }
        agent.preserveAbortedTurn(runContentOr(input), this.responseBuffer || undefined);
        this.saveCurrent({ turnState: 'aborted' });
        if (this.options.hooks) await this.emitTurnAfter(input, 'aborted', Date.now() - startedAt, false);
        onEvent({ type: 'turn:finish', input, status: 'aborted', elapsedMs: Date.now() - startedAt });
        return;
      }
      if (this.options.hooks) {
        await this.options.hooks.emit('turn:error', { runtime: this.options.host, input, content, error });
      }
      await this.failTurn(input, startedAt, error);
    }
  }

  private async failTurn(input: RuntimeInput, startedAt: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.options.agent.preserveAbortedTurn(runContentOr(input), this.responseBuffer || undefined);
    this.saveCurrent({ turnState: 'error' });
    if (this.options.hooks) await this.emitTurnAfter(input, 'error', Date.now() - startedAt, true);
    this.options.onEvent({
      type: 'turn:finish',
      input,
      status: 'error',
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
  }

  private async emitTurnAfter(
    input: RuntimeInput,
    outcome: 'completed' | 'aborted' | 'error',
    elapsedMs: number,
    hasError: boolean,
  ): Promise<void> {
    await this.options.hooks?.emit('turn:after', {
      input,
      elapsedMs,
      hasError,
      outcome,
      owner: this.options.agent,
    });
  }

  private saveCurrent(options: { allowEmpty?: boolean; turnState: 'running' | 'completed' | 'aborted' | 'error' }): void {
    if (this.options.save === false) return;
    const conversationMessages = this.options.getConversationMessages?.();
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
