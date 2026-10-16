/**
 * 侧栏会话搜索的纯逻辑，运行时与页面共用。
 *
 * 两侧必须对「怎样算命中」「命中排多前」「片段从哪儿切」有一致的判断：
 * 运行时在会话文件里做内容搜索（见 apps/desktop/src/host/stats.js），页面在已有元数据上
 * 做标题/目录匹配并渲染高亮。各写一份就会分叉——同一个词在一侧命中、在另一侧不命中，
 * 或者高亮区间对不上文字。所以匹配、打分、切片只保留这一份实现。
 *
 * 折叠（fold）是**长度保持**的：全角→半角、大写→小写都只做 1:1 替换，于是「按折叠后的
 * 文本找到的命中区间」可以直接切原始文本，片段里显示的还是用户原本写的话（不会被小写化）。
 */

/** 全角 ASCII（U+FF01–U+FF5E）→ 半角，1:1。 */
const FULLWIDTH_ASCII = /[\uFF01-\uFF5E]/g;

/** 换行/制表/控制字符 → 空格，1:1（片段要单行显示，又不能让区间错位）。 */
const INLINE_BREAKS = /[\u0000-\u001f\u007f]/g;

export function foldSearchText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  let folded = text.replace(FULLWIDTH_ASCII, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (folded.includes('\u3000')) folded = folded.replace(/\u3000/g, ' ');
  const lower = folded.toLowerCase();
  // 极少数字符小写化后会变长（例如 'İ'），那时放弃小写——保长度比多match 一个字符重要。
  return lower.length === folded.length ? lower : folded;
}

/**
 * 查询串 → 折叠后的词元。空白（含全角空格）分词，重复词只留一个。
 * 词元都经过折叠，所以「ＭＩＣＡ」「Mica」「mica」查的是同一件事。
 */
export function tokenizeSearchQuery(query: unknown): string[] {
  const folded = foldSearchText(query).trim();
  if (!folded) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of folded.split(/\s+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function matchAllTokens(foldedText: string, tokens: string[]): boolean {
  for (const token of tokens) if (!foldedText.includes(token)) return false;
  return true;
}

/** 命中区间（按折叠文本的索引，与原始文本一一对应）。相邻/重叠区间合并，最多返回上限个。 */
export function matchRanges(foldedText: string, tokens: string[], maxRanges = 40): Array<[number, number]> {
  if (!foldedText || !tokens.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = foldedText.indexOf(token);
    let hits = 0;
    while (from >= 0 && hits < maxRanges) {
      ranges.push([from, from + token.length]);
      hits += 1;
      from = foldedText.indexOf(token, from + token.length);
    }
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [ranges[0]!];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.slice(0, maxRanges);
}

export interface SearchSnippet {
  /** 单行片段（首尾可能带省略号），命中区间相对片段起点。 */
  text: string;
  ranges: Array<[number, number]>;
}

/**
 * 取命中附近的单行片段。片段用**原始**文本切片（折叠是长度保持的，索引可以直接搬过来），
 * 所以显示的是用户原本的大小写。
 */
export function extractSnippet(text: string, tokens: string[], radius = 48): SearchSnippet | null {
  const source = typeof text === 'string' ? text : '';
  if (!source || !tokens.length) return null;
  const folded = foldSearchText(source);
  const ranges = matchRanges(folded, tokens);
  if (!ranges.length) return null;

  const [firstStart, firstEnd] = ranges[0]!;
  const from = Math.max(0, firstStart - radius);
  const to = Math.min(source.length, firstEnd + radius);
  const inline = source.slice(from, to).replace(INLINE_BREAKS, ' ');
  // 掐掉首尾空白后区间要跟着挪，否则高亮会落在错的字上。
  const lead = inline.length - inline.trimStart().length;
  const body = inline.trim();
  if (!body) return null;
  const shifted: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const shiftStart = Math.max(0, start - from - lead);
    const shiftEnd = Math.min(body.length, end - from - lead);
    if (shiftEnd > shiftStart) shifted.push([shiftStart, shiftEnd]);
  }
  const prefix = from > 0 ? '…' : '';
  const suffix = to < source.length ? '…' : '';
  // 区间相对**返回的片段**（含省略号），渲染层直接照着切片即可。
  const offset = prefix.length;
  return {
    text: `${prefix}${body}${suffix}`,
    ranges: shifted.map(([start, end]) => [start + offset, end + offset] as [number, number]),
  };
}

/**
 * 命中位置的分档：越靠前的字段命中越相关。内容命中（只有运行时才知道）最低，
 * 因为它更像「顺带提到过」而不是「就是这条」。
 */
export const SEARCH_TIERS = {
  content: 1,
  extras: 2,
  id: 3,
  cwdPath: 4,
  cwdName: 5,
  titleContains: 6,
  titlePrefix: 7,
} as const;

export interface SessionSearchFields {
  title?: string | null;
  cwd?: string | null;
  id?: string | null;
  /** 分组名、定时任务内容这类附加可搜字段。 */
  extras?: Array<string | null | undefined>;
  /** 运行时已确认这个词在会话内容里出现过。 */
  hasContent?: boolean;
}

function lastSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function tokenTier(token: string, fields: SessionSearchFields): number {
  const title = foldSearchText(fields.title ?? '');
  if (title) {
    if (title.startsWith(token)) return SEARCH_TIERS.titlePrefix;
    if (title.includes(token)) return SEARCH_TIERS.titleContains;
  }
  const cwd = foldSearchText(fields.cwd ?? '');
  if (cwd) {
    const name = foldSearchText(lastSegment(fields.cwd ?? ''));
    if (name.includes(token)) return SEARCH_TIERS.cwdName;
    if (cwd.includes(token)) return SEARCH_TIERS.cwdPath;
  }
  if (foldSearchText(fields.id ?? '').includes(token)) return SEARCH_TIERS.id;
  for (const extra of fields.extras ?? []) {
    if (foldSearchText(extra ?? '').includes(token)) return SEARCH_TIERS.extras;
  }
  return fields.hasContent ? SEARCH_TIERS.content : 0;
}

/**
 * 相关度：每个词元各自取最高档位，`-1` 表示有词元没命中（整体不算命中）。
 * 总分的构成是「最差的那个词元的档位 × 100 + 各词元档位之和」——先保证「所有词都命中了
 * 标题」排在「一个词命中标题、另一个只在内容里出现过」前面，再用总和区分同档内的强弱。
 */
export function scoreSessionSearch(fields: SessionSearchFields, tokens: string[]): number {
  if (!tokens.length) return -1;
  let min = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const token of tokens) {
    const tier = tokenTier(token, fields);
    if (!tier) return -1;
    min = Math.min(min, tier);
    sum += tier;
  }
  return min * 100 + sum;
}

export interface SessionSearchRange {
  id: string;
  label: string;
  /** 天数；`0` 表示不限时间。 */
  days: number;
}

/**
 * 时间范围。语义是「最近 N 天」= 今天（本地时区当天）往前数 N-1 天，天数含今天，
 * 与用户说「最近 3 天」时的直觉一致（而不是精确的 72 小时滚动窗口）。
 */
export const SESSION_SEARCH_RANGES: SessionSearchRange[] = [
  { id: '1d', label: '今天', days: 1 },
  { id: '3d', label: '3 天', days: 3 },
  { id: '7d', label: '7 天', days: 7 },
  { id: '30d', label: '30 天', days: 30 },
  { id: 'all', label: '全部', days: 0 },
];

export const DEFAULT_SESSION_SEARCH_RANGE = '3d';

export function sessionSearchRange(rangeId: unknown): SessionSearchRange {
  return (
    SESSION_SEARCH_RANGES.find((range) => range.id === rangeId) ??
    SESSION_SEARCH_RANGES.find((range) => range.id === DEFAULT_SESSION_SEARCH_RANGE)!
  );
}

/** 时间范围的下界（毫秒）；`0` 表示不限时间。 */
export function sessionSearchSinceMs(rangeId: unknown, nowMs: number): number {
  const { days } = sessionSearchRange(rangeId);
  if (days <= 0) return 0;
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}
