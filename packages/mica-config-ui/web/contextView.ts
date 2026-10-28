import type {
  ConfigWebContextAnalysis,
  ConfigWebContextItem,
  ConfigWebContextKind,
} from '../src/shared/types.js';

/**
 * 上下文占用的展示换算：分段、占比、排序、提示文案。
 *
 * 数据来自 `readSessionContextAnalysis`（server 侧的 `contextBreakdown`），这里只做纯展示，
 * 与 host / 运行时无关——桌面端的会话详情与浏览器里的配置页共用同一份实现。
 */

/** 界面上固定按这个顺序分组，避免类别顺序随体积跳动。 */
export const CONTEXT_KIND_ORDER: ConfigWebContextKind[] = [
  'user',
  'assistant',
  'reasoning',
  'tool_call',
  'tool_result',
  'envelope',
  'other',
];

export const CONTEXT_KIND_LABELS: Record<ConfigWebContextKind, string> = {
  user: '用户消息',
  assistant: '助手回复',
  reasoning: '思考（reasoning）',
  tool_call: '工具调用参数',
  tool_result: '工具结果',
  envelope: '消息结构（信封）',
  other: '其它',
};

/** 差额那一行：最近一次请求的 input 减掉持久化消息体之后剩下的部分。 */
export const OVERHEAD_LABEL = '系统提示词 / 工具 schema / 其它差额';

export function formatTokens(value: number): string {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function sharePct(tokens: number, total: number): number {
  const sum = Number(total) || 0;
  if (sum <= 0) return 0;
  return Math.min(100, Math.round(((Number(tokens) || 0) / sum) * 1000) / 10);
}

/** 占比文字：极小但非零的值不显示成 0%，否则看起来像没占。 */
export function formatShare(tokens: number, total: number): string {
  if (!(Number(tokens) > 0) || !(Number(total) > 0)) return '0%';
  const pct = sharePct(tokens, total);
  return pct === 0 ? '<0.1%' : `${pct}%`;
}

/**
 * 占比的分母：优先用最近一次真实请求的 input（与状态栏 ctx 同源）。
 *
 * 快照在最近一次请求之后被 compact 过时那次 input 已经作废（`lastInputTokens` 为 0），
 * 退回消息体估算当分母，否则「已被压缩清掉的内容」会被算成占比里的一大块。
 * 消息体本身已经不小于那次 input 时同样退回消息体，否则各类占比之和会超过 100%。
 */
export function contextTotalTokens(analysis: ConfigWebContextAnalysis | null | undefined): number {
  if (!analysis) return 0;
  const messageTokens = Number(analysis.messageTokens) || 0;
  const lastInputTokens = Number(analysis.lastInputTokens) || 0;
  if (lastInputTokens > 0) return Math.max(lastInputTokens, messageTokens);
  return messageTokens;
}

export type ContextSegment = {
  key: string;
  label: string;
  tokens: number;
  kind: ConfigWebContextKind | 'overhead';
};

/** 堆叠条的分段：先按固定顺序放持久化消息的类别，最后是不可见的 overhead。 */
export function contextBarSegments(analysis: ConfigWebContextAnalysis | null | undefined): ContextSegment[] {
  if (!analysis) return [];
  const categories = Array.isArray(analysis.categories) ? analysis.categories : [];
  const byKind = new Map(categories.map((row) => [row.kind, row]));
  const segments: ContextSegment[] = [];
  for (const kind of CONTEXT_KIND_ORDER) {
    const row = byKind.get(kind);
    if (!row || !row.tokens) continue;
    segments.push({ key: kind, label: CONTEXT_KIND_LABELS[kind], tokens: row.tokens, kind });
  }
  if (analysis.overheadTokens > 0) {
    segments.push({
      key: 'overhead',
      label: OVERHEAD_LABEL,
      tokens: analysis.overheadTokens,
      kind: 'overhead',
    });
  }
  return segments;
}

function formatTimestamp(value?: string): string {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 最近一次请求的 input 被 compact / 裁剪作废时的说明（没有这种情况就返回空串）。 */
export function staleReferenceNote(analysis: ConfigWebContextAnalysis | null | undefined): string {
  const stale = analysis?.staleInput;
  const inputTokens = Number(stale?.inputTokens) || 0;
  if (inputTokens <= 0) return '';
  if (stale?.reason === 'truncated') {
    return `这份快照的历史在最近一次请求之后被裁剪过（请求时 ${stale.recordedMessages} 条消息，现在 ${stale.currentMessages} 条）：那次请求的 input ${inputTokens.toLocaleString()} 含已被裁掉的内容，与当前快照不可比，不计入占比。`;
  }
  const at = formatTimestamp(stale?.compactedAt);
  const when = at ? `（${at}）` : '';
  return `这份快照在最近一次请求之后被压缩过${when}：那次请求的 input ${inputTokens.toLocaleString()} 含已被压缩清理的内容，与当前快照不可比，不计入占比。`;
}

/** 消息体估算已经不小于最近一次请求 input 时的说明：两者不可比，改用消息体当分母。 */
export function bodyOverInputNote(analysis: ConfigWebContextAnalysis | null | undefined): string {
  const lastInputTokens = Number(analysis?.lastInputTokens) || 0;
  const messageTokens = Number(analysis?.messageTokens) || 0;
  if (lastInputTokens <= 0 || messageTokens <= lastInputTokens) return '';
  return `持久化消息体估算（~${formatTokens(messageTokens)}）已不小于最近一次请求的 input ${lastInputTokens.toLocaleString()}（请求之后追加的消息，或 chars/4 与实际 tokenize 的差异），占比以消息体为分母、不显示差额。`;
}

/** 差额大到「消息体 + 最小请求 input」都解释不了时的说明。 */
export function overheadNote(analysis: ConfigWebContextAnalysis | null | undefined): string {
  const overheadTokens = Number(analysis?.overheadTokens) || 0;
  const fixedOverheadTokens = Number(analysis?.fixedOverheadTokens) || 0;
  const messageTokens = Number(analysis?.messageTokens) || 0;
  if (overheadTokens <= 0 || fixedOverheadTokens <= 0) return '';
  if (overheadTokens <= messageTokens + fixedOverheadTokens) return '';
  return `差额 ~${formatTokens(overheadTokens)} 超过「消息体估算 + 本会话最小请求 input（${fixedOverheadTokens.toLocaleString()}，固定开销的上界）」能解释的量：里面含图片的 vision token、chars/4 估不出的真实 tokenize，或已被压缩 / 裁剪掉的历史，不能都算作 system prompt / 工具 schema。`;
}

export function filterContextItems(
  items: ConfigWebContextItem[],
  kind: ConfigWebContextKind | 'all',
): ConfigWebContextItem[] {
  const list = Array.isArray(items) ? items : [];
  if (!kind || kind === 'all') return list;
  return list.filter((item) => item.kind === kind);
}

/** `size` 用于「谁占了上下文」，`order` 用于顺着对话看。 */
export function sortContextItems(items: ConfigWebContextItem[], mode: 'size' | 'order'): ConfigWebContextItem[] {
  const list = [...(Array.isArray(items) ? items : [])];
  if (mode === 'order') return list;
  return list.sort((a, b) => b.tokens - a.tokens || a.sequence - b.sequence);
}

export function contextItemCounts(items: ConfigWebContextItem[]): Map<ConfigWebContextKind, number> {
  const counts = new Map<ConfigWebContextKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return counts;
}

/** 单行摘要：折叠空白后截断，用来在列表里直接认出这条是什么。 */
export function contentPreview(text: string | undefined, max = 60): string {
  if (!text) return '';
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 每行的主标题。行首徽章已经写明类别，所以标题给最能认出内容的东西：
 * 工具名 > 正文摘要 > 类别兜底。
 */
export function contextItemTitle(item: ConfigWebContextItem): string {
  if (item.name) return item.name;
  const preview = contentPreview(item.content);
  if (preview) return preview;
  return CONTEXT_KIND_LABELS[item.kind];
}

/** 每行的副标题：清理标记、媒体张数、调用 id。 */
export function contextItemSubtitle(item: ConfigWebContextItem): string {
  const bits: string[] = [];
  if (item.kind === 'tool_call' && item.content) bits.push(contentPreview(item.content, 48));
  if (item.cleared) bits.push('已清理为占位符');
  if ((item.imageCount ?? 0) > 0) bits.push(`含 ${item.imageCount} 张图片（未计入估算）`);
  else if (item.hasImage) bits.push('含图片');
  if ((item.mediaCount ?? 0) > 0) bits.push(`含 ${item.mediaCount} 个文档/文件（未计入估算）`);
  if ((item.encryptedChars ?? 0) > 0) bits.push('含加密推理链');
  if (item.truncated && item.kind !== 'tool_call') bits.push('正文已截断');
  if (item.toolCallId) bits.push(item.toolCallId.slice(0, 16));
  return bits.join(' · ');
}

/** 类别在堆叠条 / 图例 / 类别表里的同一个颜色。 */
export function contextKindClass(kind: ConfigWebContextKind | 'overhead'): string {
  return `context-kind-${kind}`;
}

