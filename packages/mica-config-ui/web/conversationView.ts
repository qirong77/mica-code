import { formatCharCount } from './format.js';
import type { ConfigWebConversationItem } from '../src/shared/types.js';

/**
 * 对话记录的读法：把扁平的历史整理成「轮 → 动作段 → 单条」。
 *
 * 落盘的 provider 历史是一条扁平数组：用户问一句，后面跟几十条工具调用与思考。
 * 平铺出来就是一百多行长得一样的记录，读不出「这句话导致了什么」。这里只做纯计算，
 * 长相留给组件（`components/ConversationPane.tsx`），也因此能单独测。
 */

export type ConversationFilter = 'all' | 'talk' | 'tools' | 'thinking';

export const CONVERSATION_FILTERS: { value: ConversationFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'talk', label: '对话' },
  { value: 'tools', label: '工具' },
  { value: 'thinking', label: '思考' },
];

/** 连续的工具调用 / 结果 / 思考属于「一次模型往返里的动作」，不是对话内容。 */
const MACHINE_TYPES = new Set(['tool_call', 'tool_result', 'reasoning', 'system', 'unknown']);

/** 一段最多折这么多条：再长就切成几段，滚动时能感觉到进展，而不是一坨。 */
const RUN_CHUNK = 12;

/** 少于这个数就不折——两三条还折一层，反而多点一次。 */
const RUN_MIN = 4;

export type TurnStats = { records: number; tools: number; thinking: number; chars: number };

/** 一「轮」= 一条用户消息 + 它之后到下一个用户消息之前的全部记录。 */
export type TurnBlock = {
  key: string;
  turn: ConfigWebConversationItem | null;
  records: ConfigWebConversationItem[];
  stats: TurnStats;
};

export type ConversationRun =
  | { kind: 'group'; key: string; records: ConfigWebConversationItem[] }
  | { kind: 'single'; key: string; record: ConfigWebConversationItem };

export function conversationItemSize(item: ConfigWebConversationItem): number {
  return item.sizeHint ?? item.content.length;
}

export function buildTurnBlocks(items: ConfigWebConversationItem[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let current: TurnBlock | null = null;
  for (const item of items) {
    if (item.type === 'user') {
      current = { key: `turn-${item.sequence}`, turn: item, records: [], stats: { records: 0, tools: 0, thinking: 0, chars: 0 } };
      blocks.push(current);
      continue;
    }
    if (!current) {
      // 这一轮的用户消息在还没加载的那一页里：记录照常显示，只是没有段头。
      current = { key: `head-${item.sequence}`, turn: null, records: [], stats: { records: 0, tools: 0, thinking: 0, chars: 0 } };
      blocks.push(current);
    }
    current.records.push(item);
    current.stats.records += 1;
    current.stats.chars += conversationItemSize(item);
    if (item.type === 'tool_call' || item.type === 'tool_result') current.stats.tools += 1;
    if (item.type === 'reasoning') current.stats.thinking += 1;
  }
  return blocks;
}

export function formatTurnStats(stats: TurnStats): string {
  if (stats.records === 0) return '没有后续记录';
  const parts = [`${stats.records} 条记录`];
  if (stats.tools > 0) parts.push(`工具 ${stats.tools}`);
  if (stats.thinking > 0) parts.push(`思考 ${stats.thinking}`);
  parts.push(`${formatCharCount(stats.chars)} 字符`);
  return parts.join(' · ');
}

export function conversationFilterOf(item: ConfigWebConversationItem): Exclude<ConversationFilter, 'all'> {
  if (item.type === 'reasoning') return 'thinking';
  if (item.type === 'tool_call' || item.type === 'tool_result') return 'tools';
  return 'talk';
}

export function matchesConversationQuery(item: ConfigWebConversationItem, keyword: string): boolean {
  return (
    item.content.toLowerCase().includes(keyword) ||
    (item.toolName?.toLowerCase().includes(keyword) ?? false) ||
    (item.callId?.toLowerCase().includes(keyword) ?? false)
  );
}

export function conversationItemLabel(item: ConfigWebConversationItem): string {
  if (item.type === 'assistant') return '回答';
  if (item.type === 'tool_call') return '工具调用';
  if (item.type === 'tool_result') return '工具结果';
  if (item.type === 'reasoning') return '思考';
  if (item.type === 'system') return '系统';
  if (item.type === 'unknown') return item.role || '其它';
  return '你';
}

/** 只用来上色：类型名多半带下划线，直接拼进 class 名不好读也不好写选择器。 */
export function conversationKindClass(type: string): string {
  if (type === 'tool_call') return 'tool';
  if (type === 'tool_result') return 'result';
  return type;
}

/** 把一段记录切成「单条」与「连续动作段」，连续动作段按 RUN_CHUNK 再分块。 */
export function splitConversationRuns(records: ConfigWebConversationItem[]): ConversationRun[] {
  const runs: ConversationRun[] = [];
  let buffer: ConfigWebConversationItem[] = [];
  const flush = () => {
    if (buffer.length >= RUN_MIN) {
      // 先按「整段够不够长」定折叠，再切块：否则一段的尾巴（不足 RUN_MIN）会被拆成
      // 几条散落的原始行，同一批工具一半折着、一半摊着。
      for (let index = 0; index < buffer.length; index += RUN_CHUNK) {
        const chunk = buffer.slice(index, index + RUN_CHUNK);
        runs.push({ kind: 'group', key: `run-${chunk[0]!.sequence}`, records: chunk });
      }
    } else {
      for (const record of buffer) runs.push({ kind: 'single', key: `one-${record.sequence}`, record });
    }
    buffer = [];
  };
  for (const record of records) {
    if (MACHINE_TYPES.has(record.type)) {
      buffer.push(record);
      continue;
    }
    flush();
    runs.push({ kind: 'single', key: `one-${record.sequence}`, record });
  }
  flush();
  return runs;
}

/** 一段动作在折叠状态下要说清「干了什么」：主要工具各调了几次、思考了几次。 */
export function describeConversationRun(records: ConfigWebConversationItem[]): string {
  const tools = new Map<string, number>();
  let thinking = 0;
  for (const record of records) {
    if (record.type === 'reasoning') thinking += 1;
    else if (record.type === 'tool_call') {
      const name = record.toolName || '工具';
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  const parts: string[] = [`${records.length} 条`];
  const names = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  if (names.length > 0) {
    const shown = names
      .slice(0, 3)
      .map(([name, count]) => `${name} ×${count}`)
      .join('、');
    parts.push(names.length > 3 ? `${shown} 等 ${names.length} 种` : shown);
  }
  // 纯思考的段不该写成「6 条 · 思考 6」——次数就是条数时不再重复一遍。
  if (thinking > 0 && names.length > 0) parts.push(`思考 ${thinking}`);
  return parts.join(' · ');
}

/** 段首那两个字跟着内容走：整段只有思考时写成「工具」会指错东西。 */
export function conversationRunLabel(records: ConfigWebConversationItem[]): string {
  if (records.some((record) => record.type === 'tool_call' || record.type === 'tool_result')) return '工具';
  if (records.some((record) => record.type === 'reasoning')) return '思考';
  return '记录';
}

/**
 * 图片引用在预览里只留一枚占位：`[Image](~/.mica/images/xxx.png)` 一条就吃掉一百多个字符，
 * 连着几张图时整行预览全是路径，真正要说的话被挤出可视区。
 *
 * 一条多模态消息抽出来是「路径 + 一个裸 [Image]」，两种形态都要收掉，否则旁边还躺着一枚。
 */
const MEDIA_REF =
  /!?\[[^\]]*\]\((?:data:image\/[^)]*|[^)]*\/images\/[^)]*|[^)]*\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^)]*)?)\)|\[(?:image|图片|img)\]/gi;

export function conversationPreview(content: string, limit: number): string {
  const raw = content.slice(0, 2_000);
  const truncatedSource = raw.length < content.length;
  const normalized = raw
    .replace(MEDIA_REF, '[图片]')
    .replace(/(?:\[图片\]\s*){2,}/g, '[图片] ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > limit || truncatedSource ? `${normalized.slice(0, limit)}…` : normalized;
}
