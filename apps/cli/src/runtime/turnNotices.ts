import type { MicaUiCommandStatus, MicaUiConversationMessage } from '@packages/mica-ui/index.js';

export type TurnNotice = Extract<MicaUiConversationMessage, { role: 'notice' }>;

/** Title used by the retry hint; one slot per turn, updated in place. */
export const TURN_RETRY_NOTICE_COMMAND = '/retry';
/** Title used by the final failure hint. */
export const TURN_ERROR_NOTICE_COMMAND = '/error';

type NoticeEntry = { message: TurnNotice; after: number };

/**
 * Notices that live in the session's `conversationMessages` (retry hints, turn
 * failures, command results) but never in the provider history.
 *
 * Each notice remembers how many committed conversation messages preceded it
 * (`after`), so a later save can put it back where it belongs. Without that,
 * notices are only appended after the whole transcript and an old `/error`
 * ends up below conversations that happened long after it. Notices are dropped
 * wholesale when the history is rewritten (compact), matching the CLI.
 */
export class TurnNoticeLog {
  private entries: NoticeEntry[] = [];
  private readonly base: () => MicaUiConversationMessage[];

  constructor(base: () => MicaUiConversationMessage[]) {
    this.base = base;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Rebuilds the log from a persisted session. `after` is inferred from each
   * notice's position: the number of user/assistant messages in front of it.
   */
  restore(conversationMessages: unknown): void {
    this.entries = [];
    if (!Array.isArray(conversationMessages)) return;
    let after = 0;
    for (const value of conversationMessages) {
      if (!value || typeof value !== 'object') continue;
      const message = value as Record<string, unknown>;
      if (message.role === 'notice') {
        const notice = toNotice(message);
        if (notice) this.entries.push({ after, message: notice });
        continue;
      }
      if (message.role === 'user' || message.role === 'assistant') after += 1;
    }
  }

  append(message: TurnNotice): void {
    this.entries.push({ after: this.base().length, message });
  }

  /** Updates the last notice in place when it belongs to the same turn and slot. */
  upsert(message: TurnNotice): void {
    // A progress notice (status=running) is updated wherever it sits: /commit
    // and /compact walk from running to success and must not leave two rows.
    const runningIndex = message.command ? findLastRunningIndex(this.entries, message.command) : -1;
    if (runningIndex >= 0) {
      this.entries[runningIndex] = { ...this.entries[runningIndex], message };
      return;
    }
    const after = this.base().length;
    const last = this.entries.at(-1);
    if (last && last.after === after && last.message.command && last.message.command === message.command) {
      last.message = message;
      return;
    }
    this.entries.push({ after, message });
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * Provider-derived conversation with the notices threaded back into place.
   * `extra` are messages that complete the current turn but are not in the
   * provider history yet (the in-flight user prompt): they belong before every
   * notice created for that turn, so their count shifts those anchors.
   */
  compose(extra: MicaUiConversationMessage[] = []): MicaUiConversationMessage[] {
    const original = this.base();
    const base = extra.length > 0 ? [...original, ...extra] : original;
    if (this.entries.length === 0) return base;
    const result: MicaUiConversationMessage[] = [];
    let cursor = 0;
    for (const entry of this.entries) {
      const anchor = entry.after >= original.length ? entry.after + extra.length : entry.after;
      const at = Math.min(Math.max(anchor, cursor), base.length);
      for (let index = cursor; index < at; index += 1) result.push(base[index]);
      result.push(entry.message);
      cursor = at;
    }
    for (let index = cursor; index < base.length; index += 1) result.push(base[index]);
    return result;
  }
}

/**
 * 插件提交的轮次里，会话记录该显示「为什么跑这一轮」而不是整段提示词。
 *
 * 本轮跑完之后用户消息进了 provider 历史（原文很长），而 `extra` 里那条是要展示的
 * 版本。直接在末尾追加会变成两条用户消息、顺序也反了（回答在前）。所以这里把原文
 * 那条就地换成展示版本、再丢掉末尾的副本——位置、顺序与 notice 锚点都不动。
 *
 * 原文对不上（历史被改写、消息已被删）时返回原数组：宁可多一条消息，也不要改错。
 */
export function mergeInFlightUserMessage(
  messages: MicaUiConversationMessage[],
  inFlight: { message: MicaUiConversationMessage; rawContent: unknown },
): MicaUiConversationMessage[] {
  const pendingIndex = messages.lastIndexOf(inFlight.message);
  if (pendingIndex < 0) return messages;
  const rawIndex = messages.findIndex(
    (entry, index) => index !== pendingIndex && entry.role === 'user' && sameContent(entry.content, inFlight.rawContent),
  );
  if (rawIndex < 0) return messages;
  const next = [...messages];
  next[rawIndex] = inFlight.message;
  next.splice(pendingIndex, 1);
  return next;
}

/**
 * 同一段输入在 provider 历史与 `RuntimeInput` 里的形态可能不同（字符串 vs 文本块数组），
 * 所以按「取出的文本」比较，而不是按结构比较。
 */
function sameContent(a: unknown, b: unknown): boolean {
  const left = contentText(a);
  return left.length > 0 && left === contentText(b);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((part) =>
      part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '',
    )
    .join('')
    .trim();
}

export function createRetryNotice(error: unknown, attempt: number, maxAttempts: number, delayMs: number): TurnNotice {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return {
    role: 'notice',
    content: [
      `请求暂时失败，将在 ${seconds}s 后自动重试（第 ${attempt}/${maxAttempts} 次）`,
      `错误：${errorMessageOf(error)}`,
    ].join('\n'),
    variant: 'error',
    command: TURN_RETRY_NOTICE_COMMAND,
  };
}

export function createTurnErrorNotice(error: unknown): TurnNotice {
  return {
    role: 'notice',
    content: `请求失败: ${errorMessageOf(error)}`,
    variant: 'error',
    command: TURN_ERROR_NOTICE_COMMAND,
  };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same field whitelist as SessionController's conversation sanitizer. */
function toNotice(value: Record<string, unknown>): TurnNotice | null {
  const content = value.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  const notice: TurnNotice = { role: 'notice', content };
  if (typeof value.displayContent === 'string') notice.displayContent = value.displayContent;
  if (isNoticeVariant(value.variant)) notice.variant = value.variant;
  if (typeof value.command === 'string') notice.command = value.command;
  if (isNoticeStatus(value.status)) notice.status = value.status;
  return notice;
}

function isNoticeVariant(value: unknown): value is NonNullable<TurnNotice['variant']> {
  return value === 'commit' || value === 'config' || value === 'compact' || value === 'error';
}

function isNoticeStatus(value: unknown): value is MicaUiCommandStatus {
  return value === 'running' || value === 'success' || value === 'warning' || value === 'error' || value === 'info';
}

function findLastRunningIndex(entries: NoticeEntry[], command: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index].message;
    if (message.command === command && message.status === 'running') return index;
  }
  return -1;
}
