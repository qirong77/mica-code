import type { SubagentEvent } from './events.js';
import { renderSubagentEvents } from './events.js';

/**
 * 子会话事件 → 父会话的一轮。
 *
 * 没有这一层时，事件只有两条送达路径：`subagent_wait` 返回，或下一轮 system prompt。
 * 父 turn 结束、用户不再说话时，第二条路永远不会发生：子会话跑完的结果就挂在
 * eventLog 里，直到用户自己想起它。自动唤醒把「父会话空闲 + 有未读事件」变成一条
 * `ctx.runtime.submit` 系统输入——这是插件侧唯一能在轮次之外让模型重新开口的通路。
 *
 * 三条边界：
 * - 父会话还在跑一轮时不动它：事件等这一轮结束（turn:after）再送，不打断；
 * - 用户正在输入或已经有排队消息时不抢：事件跟着用户这一轮进 prompt；
 * - 一次只送一轮：同批事件合并成一条，送达成功才从 eventLog 摘掉。
 */

/** 合并窗口：一轮结束和进程退出往往前后脚到，800ms 内合成一条。 */
export const WAKE_DEBOUNCE_MS = 800;

/** 哪些事件值得把父会话叫起来。接管与回收是父会话自己的动作，不唤醒。 */
export function shouldWake(event: SubagentEvent): boolean {
  return event.kind === 'turn' || event.kind === 'exit' || event.kind === 'stalled' || event.kind === 'watch';
}

export type SubagentWakeHost = {
  /** 父会话正在跑一轮：事件留给 turn:after，不在这里提交。 */
  inTurn(): boolean;
  /** 宿主侧还有独占任务或新一轮已开始：同样不抢。 */
  busy(): boolean;
  /** 用户输入框里已经有草稿：等他这一句。 */
  draft(): string;
  /** 用户已经有排队消息：事件跟着那一轮走。 */
  queued(): number;
  /** 未读事件（不消费）。 */
  peek(): SubagentEvent[];
  /** 送达成功之后摘掉。 */
  consume(ids: readonly number[]): void;
  /** 提交一条系统输入；`false` 表示宿主没收（忙/没通路）。 */
  submit(text: string, displayText: string): Promise<boolean>;
  /** 送达时给用户留一句说明。 */
  notice?(text: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
};

export function renderWakePrompt(events: readonly SubagentEvent[]): string {
  return [
    '这是一条系统事件，不是用户发言。你派出去的子会话在后台有了新动态：',
    '',
    renderSubagentEvents(events),
    '',
    '按上面的状态决定下一步：读结果、重启失败的、或继续等剩下的；用一句话把结论告诉用户（哪条子会话、成功还是失败），不要只复述它的正文，也不要让用户自己回来问。',
  ].join('\n');
}

export function wakeDisplay(events: readonly SubagentEvent[]): string {
  const titles = [...new Set(events.map((event) => event.title))];
  const shown = titles.slice(0, 3).join('、');
  const rest = titles.length > 3 ? ` 等 ${titles.length} 个` : '';
  return `子会话动态：${shown}${rest}`;
}

export class SubagentWaker {
  private timer: unknown = null;
  private disposed = false;
  private sending = false;
  /** 发送期间又来了新事件：这一条送完再排一次，不能把后一条留在队列里没人叫。 */
  private pendingBurst = false;

  constructor(private readonly host: SubagentWakeHost) {}

  /** 事件到达：合并一小段，父会话空闲就送。 */
  schedule(): void {
    if (this.disposed) return;
    this.pendingBurst = true;
    if (this.timer !== null) return;
    this.arm(WAKE_DEBOUNCE_MS);
  }

  /**
   * 一轮刚结束：立刻排一次送达。
   *
   * 不能在 `turn:after` 里直接 `flush`：headless 宿主的 `running` 要到这一轮
   * 完全退出循环后才清，直接 submit 会被排进单槽队列；而失败/中止的轮次不会
   * drain 队列，事件就跟着那条输入一起卡住。0ms 定时器让 loop 先收尾。
   */
  flushSoon(): void {
    if (this.disposed) return;
    this.pendingBurst = true;
    this.clearTimer();
    this.arm(0);
  }

  /** 一轮结束或事件攒够时调用：把未读事件送出去。 */
  async flush(): Promise<void> {
    if (this.disposed || this.sending) return;
    const events = this.host.peek();
    if (!events.some(shouldWake)) return;
    if (this.host.inTurn() || this.host.busy()) return;
    if (this.host.queued() > 0) return;
    if (this.host.draft().trim()) return;
    this.sending = true;
    this.pendingBurst = false;
    try {
      const ok = await this.host.submit(renderWakePrompt(events), wakeDisplay(events));
      if (!ok) return;
      this.host.consume(events.map((event) => event.id));
      this.host.notice?.(`子会话有新动态，已回到对话（${wakeDisplay(events)}）`);
    } finally {
      this.sending = false;
      if (this.pendingBurst) {
        this.pendingBurst = false;
        this.schedule();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private arm(ms: number): void {
    const setTimer = this.host.setTimer ?? ((run, delay) => setTimeout(run, delay));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    const clearTimer =
      this.host.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    clearTimer(this.timer);
    this.timer = null;
  }
}
