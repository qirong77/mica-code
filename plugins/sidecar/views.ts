/**
 * 子会话的文本投影：同一份转录，四种成本不同的视图。
 *
 * 按「先定位、再读」的顺序用，从便宜到贵：
 * - `renderSidecar`   进度（默认视图，没有变化时只回一行）
 * - `renderTurnIndex` 轮次索引：每轮一行，用来定位「第几轮」
 * - `grepTranscript`  在对话里搜关键词，只回命中行
 * - `renderTranscript` 对话正文（不含工具与思考），按字符预算截断
 *
 * 两个硬约束决定了这里每个视图都有上限：输出会直接进父会话的上下文；而反复查看
 * 是这个能力的常态。所以一律优先保新丢旧，并且丢了多少要明说。
 */
import type { SidecarEntry } from './registry.js';
import type { SidecarTurn } from './transcript.js';

/** 单条消息在完整视图里的上限：再长就该分段读了。 */
const PER_MESSAGE_CHARS = 4_000;
/** 低于这个预算就不再塞新的一块，免得出现半句话。 */
const MIN_BLOCK_CHARS = 240;

export const DEFAULT_TRANSCRIPT_CHARS = 8_000;
export const MAX_TRANSCRIPT_CHARS = 60_000;
export const DEFAULT_TURN_INDEX_LIMIT = 10;

export function clip(text: string, limit: number): string {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 单行化：索引与命中行都只占一行，换行会把它们撑成一段。 */
function oneLine(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampInt(value: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(Math.round(number), min), max);
}

function clock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function duration(turn: SidecarTurn): string {
  if (!turn.finishedAt) return '进行中';
  const seconds = Math.max(0, Math.round((turn.finishedAt - turn.startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

/**
 * 把子会话的状态渲染成一段给人读的文本。
 *
 * 工具输出直接进父会话的上下文，所以只留「还能决定下一步」的信息：这一轮在不在跑、
 * 说到哪了、调了哪些工具、上一轮结论是什么。完整正文留在子会话自己的对话记录里。
 *
 * `quietWhenUnchanged` 是给轮询用的：转录自上次渲染以来没变时只回一行状态。
 * 查进度是个高频动作，每次都回整份投影等于让父会话按调用次数重复付 token。
 */
export function renderSidecar(
  entry: SidecarEntry,
  options: { full?: boolean; quietWhenUnchanged?: boolean } = {},
): string {
  const { process } = entry;
  const transcript = process.transcript;
  const turns = transcript.allTurns();
  const latest = transcript.latestTurn;
  const busy = transcript.busy;
  // takeWarning 是读一次就清空的，必须在可能提前返回的分支之前取出来。
  const warning = transcript.takeWarning();
  const revision = transcript.revision;
  const unchanged = entry.seenRevision === revision;
  entry.seenRevision = revision;
  if (options.quietWhenUnchanged && unchanged && !process.closed && !warning) {
    return `会话 ${entry.id} · ${busy ? '运行中' : '空闲'} · 自上次查看后没有新输出。`;
  }
  const elapsed = Math.round((Date.now() - entry.createdAt) / 1000);
  const lines = [
    `会话 ${entry.id}`,
    `状态：${busy ? '运行中' : '空闲'} · ${transcript.totalTurnCount} 轮 · 已存在 ${elapsed}s`,
    `标题：${entry.title}`,
    `目录：${entry.cwd}`,
  ];
  if (process.closed) lines.push(`进程已退出：${process.describeFailure()}`);
  if (warning) lines.push(`警告：${warning}`);

  if (latest) {
    lines.push('', `—— ${busy ? '本轮（进行中）' : `最近一轮（${latest.status}）`} ——`);
    lines.push(
      clip(latest.text || (busy ? '（还没有正文输出）' : '（这一轮没有正文）'), options.full ? 12_000 : 4_000),
    );
    if (latest.tools.length) {
      lines.push('工具调用：');
      for (const tool of latest.tools.slice(-8)) {
        lines.push(`  · ${clip(tool.title, 120)} [${tool.status}]`);
        if (tool.output && (options.full || tool.status === 'error')) {
          lines.push(indent(clip(tool.output, options.full ? 2_000 : 600), '      '));
        }
      }
    }
    if (latest.thinking && options.full) {
      lines.push('思考（节选）：', indent(clip(latest.thinking, 2_000), '  '));
    }
    if (latest.error) lines.push(`错误：${latest.error}`);
  } else {
    lines.push('', '还没有任何一轮对话。');
  }

  if (options.full && turns.length > 1) {
    const previous = turns.slice(-4, -1);
    for (const turn of previous) {
      lines.push('', `—— 更早一轮（${turn.status}）——`, clip(turn.text || '（没有正文）', 1_500));
    }
  }

  const usage = transcript.usage;
  if (usage.total > 0) {
    lines.push('', `用量：输入 ${usage.input} · 输出 ${usage.output} · 累计 ${usage.total}`);
  }
  return lines.join('\n');
}

/**
 * 轮次索引：每轮一行（时间、终态、耗时、问答各一句），用来定位「第几轮」。
 *
 * 这是「读对话」的入口而不是它的替代：先在这里找到目标轮次，再用 `renderTranscript`
 * 或 `grepTranscript` 取内容，避免为了找一句话把整段对话读进来。
 */
export function renderTurnIndex(entry: SidecarEntry, options: { limit?: number } = {}): string {
  const transcript = entry.process.transcript;
  const turns = transcript.allTurns();
  if (!turns.length) return `子会话 ${entry.id} 还没有任何一轮对话。`;
  const limit = clampInt(options.limit ?? DEFAULT_TURN_INDEX_LIMIT, 1, 20);
  const shown = turns.slice(-limit);
  const offset = turns.length - shown.length;
  const total = transcript.totalTurnCount;
  const lines = [
    `会话 ${entry.id} · 共 ${total} 轮 · ${transcript.busy ? '正在跑' : '空闲'}` +
      (transcript.omittedTurnCount > 0 ? `（保留最近 ${turns.length} 轮）` : '') +
      (offset > 0 ? `（只列最近 ${shown.length} 轮）` : ''),
  ];
  shown.forEach((turn, index) => {
    const question = turn.userInputs.at(-1)?.text;
    lines.push(
      `  ${total - shown.length + index + 1} · ${clock(turn.startedAt)} · ${turn.status} · ${duration(turn)}` +
        ` · 问 ${turn.userInputs.length + (turn.omittedUserInputs ?? 0)} 条 · 答 ${turn.text.length} 字`,
    );
    if (question) lines.push(`      问：${clip(oneLine(question), 90)}`);
    if (turn.text) lines.push(`      答：${clip(oneLine(turn.text), 110)}`);
    if (turn.error) lines.push(`      错：${clip(oneLine(turn.error), 110)}`);
  });
  return lines.join('\n');
}

export type TranscriptOptions = {
  /** 取最近几轮，默认 1。 */
  lastTurns?: number;
  /** 是否带上投进去的用户消息，默认 true。 */
  includeUser?: boolean;
  /** 这次输出的总字符预算，默认 8000（约 4k token）。 */
  maxChars?: number;
};

/**
 * 对话正文：只有用户说了什么、助手回了什么，**不含工具调用与思考**。
 *
 * 预算按字符算而不是按轮数算：一次输出的成本对调用方来说是唯一重要的东西，
 * 而「一轮有多长」完全不可预测（一句话和一份报告都是「一轮」）。
 */
export function renderTranscript(entry: SidecarEntry, options: TranscriptOptions = {}): string {
  const transcript = entry.process.transcript;
  const turns = transcript.allTurns();
  const total = transcript.totalTurnCount;
  if (!turns.length) return `子会话 ${entry.id} 还没有任何一轮对话。`;
  const lastTurns = clampInt(options.lastTurns ?? 1, 1, Math.min(20, turns.length));
  const includeUser = options.includeUser !== false;
  const budget = clampInt(options.maxChars ?? DEFAULT_TRANSCRIPT_CHARS, MIN_BLOCK_CHARS, MAX_TRANSCRIPT_CHARS);
  const selected = turns.slice(turns.length - lastTurns);
  const headerFor = (count: number): string => {
    const header = [`会话 ${entry.id} · 共 ${total} 轮 · 显示第 ${total - count + 1}–${total} 轮`];
    if (transcript.omittedTurnCount > 0) header.push(`（保留最近 ${turns.length} 轮；完整历史在子会话中）`);
    const omitted = selected.length - count;
    if (omitted > 0) {
      header.push(
        `（${omitted} 轮更早的对话没放进来：超出 ${budget} 字符预算。用 sidecar_turns 定位后再调大 max_chars）`,
      );
    }
    return header.join('\n');
  };

  // 从最新往回装，装不下就停：预算不够时丢掉的是最早的轮次，不是最新的结论。
  const blocksNewestFirst: string[] = [];
  let used = 0;
  for (let index = selected.length - 1; index >= 0; index--) {
    const count = blocksNewestFirst.length + 1;
    const remaining = budget - used - headerFor(count).length - count * 2;
    if (remaining <= 0 || (blocksNewestFirst.length > 0 && remaining < MIN_BLOCK_CHARS)) break;
    const block = renderTurnBlock(selected[index]!, {
      number: total - selected.length + index + 1,
      includeUser,
      capacity: Math.min(remaining, PER_MESSAGE_CHARS),
    });
    if (!block) break;
    blocksNewestFirst.push(block);
    used += block.length;
  }
  const blocks = blocksNewestFirst.reverse();
  return [headerFor(blocks.length), ...blocks].join('\n\n');
}

function renderTurnBlock(
  turn: SidecarTurn,
  options: { number: number; includeUser: boolean; capacity: number },
): string | null {
  if (options.capacity <= 0) return null;
  const heading = `—— 第 ${options.number} 轮 · ${turn.status}` +
    (options.includeUser && turn.omittedUserInputs ? ` · 省略 ${turn.omittedUserInputs} 条早期用户消息` : '') + ' ——';
  const asked = options.includeUser ? turn.userInputs.map((input) => input.text).join('\n') : '';
  const body = turn.text || (turn.status === 'running' ? '（还没有正文输出）' : '（这一轮没有正文）');
  const fixed = [heading, ...(asked ? ['[用户] '] : []), '[助手] ', ...(turn.error ? ['[错误] '] : [])].join('\n');
  const remaining = Math.max(0, options.capacity - fixed.length);
  const question = asked ? fitText(asked, Math.min(1_500, Math.floor(remaining / 3))) : '';
  const error = turn.error ? fitText(turn.error, Math.min(600, Math.floor(remaining / 4))) : '';
  const parts = [heading];
  if (asked) parts.push(`[用户] ${question}`);
  parts.push(`[助手] ${fitText(body, remaining - question.length - error.length)}`);
  if (turn.error) parts.push(`[错误] ${error}`);
  return parts.join('\n');
}

/** 与 clip 不同，这里的省略号也计入硬字符预算。 */
function fitText(text: string, capacity: number): string {
  if (capacity <= 0) return '';
  return text.length <= capacity ? text : `${text.slice(0, capacity - 1)}…`;
}

/**
 * 在对话里搜关键词，只回命中那一行。
 *
 * 存在的理由就是省上下文：想知道「它在哪说过这个报错」，用 `renderTranscript` 得先把
 * 整段对话读进来自己找，而这里只回几行。
 */
export function grepTranscript(entry: SidecarEntry, options: { pattern: RegExp; maxMatches?: number }): string {
  // 带 g / y 的正则在 test() 上是有状态的（lastIndex），逐行匹配会漏行。
  const pattern = new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, ''));
  const maxMatches = clampInt(options.maxMatches ?? 8, 1, 30);
  const transcript = entry.process.transcript;
  const turns = transcript.allTurns();
  const hits: string[] = [];
  let total = 0;
  turns.forEach((turn, index) => {
    const sources = [
      ...turn.userInputs.map((input) => ({ role: '用户', text: input.text })),
      { role: '助手', text: turn.text },
    ];
    for (const source of sources) {
      if (!source.text) continue;
      for (const line of source.text.split('\n')) {
        if (!pattern.test(line)) continue;
        total += 1;
        if (hits.length < maxMatches) {
          hits.push(`  [第${transcript.omittedTurnCount + index + 1}轮 · ${source.role}] ${excerpt(line, pattern)}`);
        }
      }
    }
  });
  if (!total) return `在 ${entry.id} 的对话里没有命中 /${pattern.source}/。`;
  const lines = [`会话 ${entry.id} · 命中 ${total} 处：`, ...hits];
  if (total > hits.length) {
    lines.push(`（另有 ${total - hits.length} 处未列出：收窄 pattern 或提高 max_matches）`);
  }
  return lines.join('\n');
}

/** 命中行只保留命中点附近的一段，一行日志动辄上千字符。 */
function excerpt(line: string, pattern: RegExp): string {
  const text = oneLine(line);
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return clip(text, 160);
  const start = Math.max(0, match.index - 50);
  const end = Math.min(text.length, match.index + match[0].length + 110);
  return clip(`${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, 160);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
