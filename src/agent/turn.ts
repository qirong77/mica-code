import mitt from 'mitt';
import { AgentSession } from './agent-session.js';
import { ToolExecutor } from './tool-executor.js';
import { IterationRunner } from './iteration-runner.js';
import { AgentRunLoop } from './run-loop.js';
import type { AgentTurnEvents, IterationResult, Middleware, RunFn } from './types.js';

export type { AgentTurnEvents, IterationResult, RunFn, Middleware } from './types.js';

export class AgentTurn {
  readonly events = mitt<AgentTurnEvents>();
  readonly session = new AgentSession();

  private middlewares: Middleware[] = [];
  private abortController: AbortController | null = null;
  private _aborted = false;
  private toolExecutor: ToolExecutor;
  private iterationRunner: IterationRunner;
  private runLoop: AgentRunLoop;

  constructor() {
    this.toolExecutor = new ToolExecutor({
      onToolUse: (payload) => this.events.emit('tool:use', payload),
      onToolOutput: (payload) => this.events.emit('tool:output', payload),
      onStatus: (status) => this.events.emit('status', status),
    });
    this.iterationRunner = new IterationRunner(
      this.session,
      this.toolExecutor,
      this.events.emit.bind(this.events),
    );
    this.runLoop = new AgentRunLoop(this.session);
  }

  abort() {
    this._aborted = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  get isAborted() {
    return this._aborted;
  }

  use(middleware: Middleware) {
    this.middlewares.push(middleware);
  }

  async executeSingleIteration(): Promise<IterationResult> {
    if (this._aborted) {
      throw new Error('ABORT');
    }
    this.abortController = new AbortController();
    return this.iterationRunner.run(this.abortController.signal);
  }

  private async coreRun(userInput: string, onIteration?: (result: IterationResult) => void) {
    this._aborted = false;
    await this.runLoop.run(
      userInput,
      {
        runIteration: () => this.executeSingleIteration(),
        isAborted: () => this._aborted,
        onAborted: () => this.events.emit('status', { type: 'idle' }),
      },
      onIteration,
    );
  }

  async run(userInput: string, onIteration?: (result: IterationResult) => void) {
    const coreRunFn: RunFn = this.coreRun.bind(this);
    const chain = this.middlewares.reduceRight<RunFn>(
      (next, mw) => (input, cb) => mw(input, next, cb),
      coreRunFn,
    );
    return chain(userInput, onIteration);
  }
}

export const agentTurn = new AgentTurn();
