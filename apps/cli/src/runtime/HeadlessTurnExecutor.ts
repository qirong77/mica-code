import type { AgentQueryContent } from '@packages/mica-agent/index.js';
import { micaRuntime, type RuntimeInput } from '@packages/mica-runtime/index.js';
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
};

/**
 * UI-agnostic turn executor shared by the per-session chat host (`mica
 * app-server`) and the sync daemon's CommandExecutor. Implements the same
 * single-slot message queue and after_iteration iteration-boundary injection
 * as the interactive runtime, minus all Ink/UI coupling:
 *
 * - one agent runs one turn at a time; while busy, new inputs are queued
 *   (after_iteration inputs are injected at a completed tool iteration,
 *   after_turn inputs start once the current turn ends);
 * - turn lifecycle is reported through `onEvent`; streamed text/tool/usage
 *   stays on the consumer side (CodexProjector or sync-event mapping), so
 *   this class never owns an output protocol;
 * - aborts stop the active turn but keep the queue draining, matching the
 *   desktop app's current abort-then-continue behavior.
 */
export class HeadlessTurnExecutor {
  private readonly queue = new micaRuntime.MessageQueueService();
  private readonly parseImageRefs: (text: string) => Promise<AgentQueryContent>;
  private running = false;
  private responseBuffer = '';

  constructor(private readonly options: HeadlessTurnExecutorOptions) {
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

  async start(input: RuntimeInput): Promise<'started' | 'queued' | 'rejected'> {
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
    const { agent, sessionController, onEvent } = this.options;
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
      sessionController.refreshFromStore();
      const reservedRunId = agent.reserveRunId();
      sessionController.saveCurrent({ allowEmpty: true, turnState: 'running' });
      const result = await agent.run(content, {
        reservedRunId,
        maxTurns: this.options.maxTurns,
        onIterationComplete: () => {
          sessionController.saveCurrent({ allowEmpty: true, turnState: 'running' });
          return this.takeQueuedIterationInput();
        },
      });
      // An abort that lands between reserveRunId() and the agent.run() check is
      // surfaced by agent.run() as an AgentAbortError below; never return here
      // silently or the client never receives a turn/completed notification and
      // the app stays "running" forever.
      if (!agent.isCurrent(result.runId)) return;
      sessionController.saveCurrent({ turnState: 'completed' });
      onEvent({ type: 'turn:finish', input, status: 'completed', elapsedMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof AgentAbortError) {
        agent.preserveAbortedTurn(
          (input.content as AgentQueryContent | undefined) ?? input.text,
          this.responseBuffer || undefined,
        );
        sessionController.saveCurrent({ turnState: 'aborted' });
        onEvent({ type: 'turn:finish', input, status: 'aborted', elapsedMs: Date.now() - startedAt });
        return;
      }
      await this.failTurn(input, startedAt, error);
    }
  }

  private async failTurn(input: RuntimeInput, startedAt: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.options.agent.preserveAbortedTurn(
      (input.content as AgentQueryContent | undefined) ?? input.text,
      this.responseBuffer || undefined,
    );
    this.options.sessionController.saveCurrent({ turnState: 'error' });
    this.options.onEvent({
      type: 'turn:finish',
      input,
      status: 'error',
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
  }

  private takeQueuedIterationInput(): Promise<AgentQueryContent | null> {
    const next = this.queue.dequeueAfterCompletedIteration(true);
    if (!next) return Promise.resolve(null);
    this.options.onEvent({ type: 'dequeue', input: next });
    this.options.onEvent({ type: 'queue:changed', pending: this.queue.list() });
    return next.source === 'system' ? Promise.resolve(next.text) : this.parseImageRefs(next.text);
  }
}
