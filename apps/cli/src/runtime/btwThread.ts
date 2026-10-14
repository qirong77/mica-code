import type { MicaBtwEntry, MicaBtwThread } from '@packages/mica-runtime/index.js';
// 直接从子路径取：`@packages/mica-builtin-commands/index.js` 会经 commands/btw.js
// 拖进 Ink/React，而 app-server 是 headless 进程（见 commands/btwThread.ts 的说明）。
import { createBtwThread, type BtwThread } from '@packages/mica-builtin-commands/commands/btwThread.js';
import { recordHelperSubagentUsage } from '@packages/mica-builtin-commands/subagentUsage.js';
import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/services.js';

/**
 * 常驻 host（`mica app-server`）里的 By The Way（btw）线程。
 *
 * 为什么需要它：桌面端的面板就是 CLI 的 `/btw`（面板里追问 = `/btw -continue`），
 * 而 btw 的会话状态是「一个可复用的隔离子代理」+「已经问过的问答」，两者都只能活在
 * host 进程里（子代理是从 host 的 agent 上拷出来的，「主流程对话记录」也只有 host 知道）。
 *
 * 三条约束写在实现里：
 * - **一次只回答一个问题**：复用的是同一个子代理，它的消息数组不是并发安全的；面板
 *   在回答期间也会禁用输入，所以拒绝第二个并发问题不是限制、而是把状态机写清楚。
 * - **不阻塞 host 的请求循环**：`runAppServer` 逐行 `await` 请求，`ask()` 必须立刻返回
 *   （真正的等待在后台 promise 里），否则主流程运行中用户按不动中断/排队。
 * - **记一次用量**：btw 的请求不属于任何 turn，不记账就会从 Stats 里整块漏掉。
 */
export type BtwThreadControllerOptions = {
  agent: CommandAgent;
  /** host 自己的会话控制器：btw 的用量要写进当前会话，空闲时立刻落盘。 */
  sessionController: CommandSessionController;
  /** 线程有变化就推一次整份快照（含「开始回答」那一帧）。 */
  onUpdate: (thread: MicaBtwThread) => void;
};

/** 面板只需要最近几轮；更早的留在会话里也没有意义（回答本身不落盘）。 */
export const MAX_BTW_ENTRIES = 20;

export class BtwThreadController {
  private readonly options: BtwThreadControllerOptions;

  private threadId = '';

  private entries: MicaBtwEntry[] = [];

  /** 当前线程的子代理（+ 已记账请求数）。重置时丢弃。 */
  private thread: BtwThread | null = null;

  private inFlight = false;

  constructor(options: BtwThreadControllerOptions) {
    this.options = options;
    this.threadId = this.newId();
  }

  snapshot(): MicaBtwThread {
    return { id: this.threadId, entries: this.entries.map((entry) => ({ ...entry })) };
  }

  /** 另起一条线程：下一次提问会重新取一份主流程对话记录当背景。 */
  reset(): void {
    this.threadId = this.newId();
    this.entries = [];
    this.thread = null;
    this.options.onUpdate(this.snapshot());
  }

  /**
   * 收下一个问题并立刻返回；回答完成后经 `onUpdate` 推回。
   *
   * `newThread` 是面板的「新话题」：不带它就是在当前线程上追问（等价 `/btw -continue`）。
   */
  ask(question: string, options: { newThread?: boolean } = {}): { ok: true } | { ok: false; message: string } {
    const text = question.trim();
    if (!text) return { ok: false, message: '问题不能为空' };
    if (this.inFlight) return { ok: false, message: '上一个 By The Way 问题还在回答中，请稍候' };
    if (options.newThread) {
      this.threadId = this.newId();
      this.entries = [];
      this.thread = null;
    }

    if (!this.thread) {
      try {
        this.thread = createBtwThread(this.options.agent);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const thread = this.thread;

    const entry: MicaBtwEntry = {
      id: this.newId(),
      question: text,
      status: 'running',
      startedAt: this.timestamp(),
      finishedAt: null,
    };
    this.entries = [...this.entries, entry].slice(-MAX_BTW_ENTRIES);
    this.inFlight = true;
    this.options.onUpdate(this.snapshot());

    void this.run(thread, entry);
    return { ok: true };
  }

  private async run(thread: BtwThread, entry: MicaBtwEntry): Promise<void> {
    // 别从 entry 上读结果：patchEntry 是替换式的，入参那个对象不会跟着变。
    let failed = false;
    let finishedAt = '';
    try {
      const reply = await thread.subagent.query(entry.question);
      finishedAt = this.timestamp();
      this.patchEntry(entry.id, { status: 'completed', answer: reply, finishedAt });
    } catch (error) {
      failed = true;
      finishedAt = this.timestamp();
      this.patchEntry(entry.id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        finishedAt,
      });
    } finally {
      this.inFlight = false;
      // btw 的请求不属于任何 turn，也不进主流程的 usageHistory：只有这里能记账。
      const requests = thread.subagent.usageHistory ?? [];
      if (requests.length > thread.recordedRequests) {
        recordHelperSubagentUsage(
          this.options.agent,
          { getCurrentSessionController: () => this.options.sessionController },
          requests.slice(thread.recordedRequests),
          {
            taskId: 'btw',
            subagentType: 'btw',
            description: entry.question,
            model: this.options.agent.config.model,
            effort: 'none',
            status: failed ? 'failed' : 'completed',
            startedAt: entry.startedAt,
            finishedAt,
          },
        );
      }
      thread.recordedRequests = requests.length;
      this.options.onUpdate(this.snapshot());
    }
  }

  private patchEntry(id: string, patch: Partial<MicaBtwEntry>): void {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  }

  private newId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
