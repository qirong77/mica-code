import type { SubagentTurn } from './transcript.js';

/**
 * 子会话的「动态」：它自己发生的事，父会话不必问就能知道。
 *
 * 没有这一层时，subagent 的一切都靠父会话主动 `subagent_wait` / `subagent_status` 去捞：
 * 父会话这一轮一旦结束（用户去忙别的了），子会话跑完的结果就没人读，只能等用户回来
 * 再问一句「跑完了吗」。事件是反方向的：**子会话结束、卡住、进程退出**都记一条，
 * 父会话下一轮开始时由 prompt 段落注入一次，读后即清。
 *
 * 三条硬约束：
 * - 只留最新的若干条（父会话的上下文比审计日志贵得多）；
 * - 每条一行摘要，细节靠工具按需去取（`subagent_status` / `subagent_read`）；
 * - 读一次就清，否则同一件事会在每一轮里重复进 prompt，既撑上下文又打破 prompt cache。
 */

export type SubagentEventKind =
  /** 一轮结束（completed / failed / interrupted）。 */
  | 'turn'
  /** 父会话登记的后台等待条件成立了。 */
  | 'watch'
  /** 进程退出了。 */
  | 'exit'
  /** 在跑但很久没有新输出，疑似卡住。 */
  | 'stalled'
  /** 空闲太久，进程被自动回收（会话历史仍在）。 */
  | 'recycled'
  /** 接管了一条已有会话。 */
  | 'attach'
  /** 其他需要让父会话知道的事实（角色退化之类）。 */
  | 'info';

export type SubagentEvent = {
  id: number;
  at: number;
  sessionId: string;
  title: string;
  kind: SubagentEventKind;
  /** 一行摘要：读的人据此决定要不要再往下查。 */
  summary: string;
  /** 可选的第二段（错误原因、退出原因），同样保持短。 */
  detail?: string;
};

export type SubagentEventInput = Omit<SubagentEvent, 'id' | 'at'> & { at?: number };

/** 事件最多留几条：再多就不是「动态」，而是一份没人读的日志。 */
export const MAX_SUBAGENT_EVENTS = 12;

export class SubagentEventLog {
  private events: SubagentEvent[] = [];
  private nextId = 1;

  add(input: SubagentEventInput): SubagentEvent {
    const event: SubagentEvent = { ...input, id: this.nextId++, at: input.at ?? Date.now() };
    this.events.push(event);
    if (this.events.length > MAX_SUBAGENT_EVENTS) {
      this.events.splice(0, this.events.length - MAX_SUBAGENT_EVENTS);
    }
    return event;
  }

  get size(): number {
    return this.events.length;
  }

  peek(): SubagentEvent[] {
    return [...this.events];
  }

  /** 取走全部未读事件：prompt 段落每轮读一次，只该看到新的那几条。 */
  take(): SubagentEvent[] {
    const taken = this.events;
    this.events = [];
    return taken;
  }

  /** 会话被关掉时顺手清掉它的事件：进程都没了，再提示「它跑完了」只会让人去找一个不存在的东西。 */
  dropSession(sessionId: string): void {
    this.events = this.events.filter((event) => event.sessionId !== sessionId);
  }

  clear(): void {
    this.events = [];
  }
}

/** 轮次状态的中文说法：事件行里用它，而不是给模型看英文枚举。 */
export function turnStatusLabel(status: SubagentTurn['status']): string {
  switch (status) {
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'interrupted':
      return '被打断';
    default:
      return '运行中';
  }
}

/**
 * 一轮的摘要：末尾几行正文 + 失败的工具数。
 *
 * 取末尾而不是开头：结论在最后一段，开头往往是「我先看看仓库结构」。
 */
export function summarizeTurn(turn: SubagentTurn): string {
  const tail = turn.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  const failed = turn.tools.filter((tool) => tool.status === 'error').length;
  const parts: string[] = [];
  if (tail) parts.push(tail.length > 200 ? `${tail.slice(0, 200)}…` : tail);
  if (failed > 0) parts.push(`（${failed} 条工具报错）`);
  if (turn.error) parts.push(`错误：${turn.error.split('\n')[0]!.slice(0, 160)}`);
  return parts.join(' ') || (turn.status === 'completed' ? '（这一轮没有正文）' : '（没有输出）');
}

function clock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const KIND_LABELS: Record<SubagentEventKind, string> = {
  turn: '轮次',
  watch: '等到了',
  exit: '退出',
  stalled: '停滞',
  recycled: '已回收',
  attach: '接管',
  info: '提示',
};

/**
 * 事件段的渲染。
 *
 * 这段会进 system prompt（追加在 base prompt 之后），所以它只在**有未读事件**时出现：
 * 渲染空串时整段消失，prompt 前缀不变，cache 不白断。
 */
export function renderSubagentEvents(events: readonly SubagentEvent[]): string {
  if (!events.length) return '';
  const lines = [
    '### 子会话动态（后台事件，不用再轮询确认）',
    '',
    ...events.map((event) => {
      const detail = event.detail ? ` · ${event.detail}` : '';
      return `- [${clock(event.at)}] ${event.sessionId.slice(0, 8)}「${event.title}」${KIND_LABELS[event.kind]}：${event.summary}${detail}`;
    }),
    '',
    '要细节用 `subagent_status` / `subagent_read` 按需取；结果已经拿到、不再需要它的进程就用 `subagent_stop({ action: "close" })` 收掉。',
  ];
  return lines.join('\n');
}
