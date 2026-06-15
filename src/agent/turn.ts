import mitt from 'mitt';
import type { Message } from '@mica/llm';
import { appendSystemLog } from '../store/logAtom.js';
import { clearBackups } from '../utils/fileHistory.js';
import { parseImageRefs } from '../components/utils/imagePaste.js';
import { AgentSession } from './agentSession.js';
import { ToolExecutor } from './toolExecutor.js';
import { IterationRunner } from './iterationRunner.js';
import type { AgentTurnEvents, IterationResult, Middleware, RunFn } from './types.js';
import type { ConversationMessage } from '../store/conversation.js';

export type { AgentTurnEvents, IterationResult, RunFn, Middleware } from './types.js';

function hasTextContent(message: Message): boolean {
  return message.content.some((block) => block.type === 'text');
}

export class AgentTurn {
  readonly events = mitt<AgentTurnEvents>();
  readonly session = new AgentSession();

  private middlewares: Middleware[] = [];
  private abortController: AbortController | null = null;
  private _aborted = false;
  private toolExecutor: ToolExecutor;
  private iterationRunner: IterationRunner;
  private _onIterationComplete: Array<(messages: ConversationMessage[]) => void> = [];

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

  onIterationComplete(cb: (messages: ConversationMessage[]) => void): () => void {
    this._onIterationComplete.push(cb);
    return () => {
      this._onIterationComplete = this._onIterationComplete.filter(c => c !== cb);
    };
  }

  private _notifyIterationComplete(): void {
    const msgs = this.session.getMessages();
    for (const cb of this._onIterationComplete) {
      try { cb(msgs); } catch { /* silence plugin errors */ }
    }
  }

  async executeSingleIteration(): Promise<IterationResult> {
    if (this._aborted) throw new Error('ABORT');
    this.abortController = new AbortController();
    return this.iterationRunner.run(this.abortController.signal);
  }

  private async coreRun(userInput: string, onIteration?: (result: IterationResult) => void) {
    this._aborted = false;
    appendSystemLog('Agent run 开始');
    this.session.clearToolRecords();
    await clearBackups();

    const userContent = parseImageRefs(userInput);
    this.session.appendUser(userContent);

    while (true) {
      if (this._aborted) {
        appendSystemLog('Agent run 被用户中断');
        this.events.emit('status', { type: 'idle' });
        return;
      }

      try {
        const result = await this.executeSingleIteration();
        onIteration?.(result);
        this._notifyIterationComplete();

        if (!result.hasToolUse && !result.wasTruncated) {
          if (!hasTextContent(result.finalMessage)) {
            appendSystemLog('Agent run 继续（响应仅含思考块，等待模型输出文本）');
            continue;
          }
          appendSystemLog('Agent run 结束（无待执行工具）');
          return;
        }
        appendSystemLog(`继续下一轮迭代（${result.wasTruncated ? '响应被截断' : '存在工具调用'}）`);
      } catch (err) {
        if (err instanceof Error && err.message === 'ABORT') {
          appendSystemLog('Agent run 被用户中断');
          this.events.emit('status', { type: 'idle' });
          return;
        }
        throw err;
      }
    }
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
