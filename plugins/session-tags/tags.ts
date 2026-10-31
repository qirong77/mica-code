import {
  annotationsOf,
  emptySessionAnnotations,
  normalizeSessionAnnotations,
  resolveAnnotationOptions,
  setSessionAnnotations,
  toggleSessionAnnotation,
  type SessionAnnotationOption,
  type SessionAnnotations,
} from '@packages/mica-plugin/sessionAnnotations.js';

/**
 * 会话标签的数据层：7 个固定色槽（照 macOS Finder 的彩色圆点），每个色槽有一个可改的
 * 名字，会话与色槽是多对多。
 *
 * 落盘用的是插件系统的通用「会话行标记」格式（`session-annotations.json`）：色槽就是
 * `options`，打标就是 `assignments`。所以宿主不需要认识「标签」，它只按 options 的颜色
 * 画点、按 options 的名字做菜单项——换成别的插件写同样的文件，界面照样能用。
 *
 * 这里只有纯函数：不碰文件、不碰 `ctx`。落盘在 `storeFile.ts`，接入在 `index.ts`。
 *
 * 几个刻意的取舍：
 * - **色槽固定 7 个**，不允许新增颜色：自由取色在深色侧栏上对比度不可控（黄色尤其），
 *   而 macOS 的标签本来就只有这 7 个；要表达新分类就改某个色槽的名字。
 * - **一个会话可以挂多个色槽**，但同一个色槽只能出现一次；顺序永远按 `TAG_COLORS`
 *   的色序而不是添加顺序，行内那排圆点的位置才不会跳。
 * - 标签**不参与侧栏归档**：Pinned / Projects / Recent 的「一个会话只在一个位置」这条
 *   规则由宿主守着，标签是跨分区的检索维度，不写进任何分区归属。
 */

export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/** 顺序即行内圆点的显示顺序，也是「第一个空闲色槽」的挑选顺序。 */
export const TAG_COLOR_ORDER: readonly TagColor[] = TAG_COLORS;

/** 与 macOS 系统色一致，深色背景上直接用，不需要再调亮度。 */
export const TAG_COLOR_HEX: Record<TagColor, string> = {
  red: '#FF3B30',
  orange: '#FF9500',
  yellow: '#FFCC00',
  green: '#28CD41',
  blue: '#007AFF',
  purple: '#AF52DE',
  gray: '#8E8E93',
};

export const DEFAULT_TAG_LABELS: Record<TagColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  gray: 'Gray',
};

export const MAX_TAG_LABEL_LENGTH = 24;

export type TagStore = SessionAnnotations;

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

export function tagColorIndex(color: TagColor): number {
  return TAG_COLORS.indexOf(color);
}

export function emptyTagStore(): TagStore {
  return {
    ...emptySessionAnnotations('Session Tags'),
    options: TAG_COLORS.map((color) => ({
      id: color,
      label: DEFAULT_TAG_LABELS[color],
      color: TAG_COLOR_HEX[color],
    })),
  };
}

/**
 * 把任意读到的 JSON 收敛成一份能用的 store。
 *
 * 7 个色槽是产品契约的一部分：文件里缺了某个色槽（旧版本写过、被手改删掉）也要补回来，
 * 否则那个颜色就再也打不上了。顺序永远按 `TAG_COLORS`。
 */
export function normalizeTagStore(raw: unknown): TagStore {
  const data = normalizeSessionAnnotations(raw, 'Session Tags');
  const byId = new Map(data.options.map((option) => [option.id, option]));
  const options: SessionAnnotationOption[] = TAG_COLORS.map((color) => {
    const found = byId.get(color);
    return {
      id: color,
      label: found?.label || DEFAULT_TAG_LABELS[color],
      color: TAG_COLOR_HEX[color],
    };
  });
  return { ...data, options, assignments: sortAssignments(data.assignments) };
}

/**
 * 归属里的颜色按色序排。
 *
 * 文件是公开格式（用户会手改、旧版本按点击顺序写过），而侧栏那排圆点的位置必须稳定：
 * 同一组标签在任何会话上都按红→灰排，用户才靠「第几个点」认得出是哪个分类。
 * 不认识的 id 在这里丢掉——它们画不出任何东西，留着只会让 `/tags` 的输出对不上。
 */
function sortAssignments(assignments: Record<string, string[]>): Record<string, string[]> {
  const order = new Map(TAG_COLORS.map((color, index) => [color as string, index]));
  const sorted: Record<string, string[]> = {};
  for (const [sessionId, colors] of Object.entries(assignments)) {
    const known = colors.filter((color) => order.has(color));
    if (known.length === 0) continue;
    sorted[sessionId] = known.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return sorted;
}

/** 色槽名字：去掉控制字符与多余空白，过长截断；空串表示这次改名无效。 */
export function cleanTagLabel(value: string): string {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.slice(0, MAX_TAG_LABEL_LENGTH);
}

export function labelOf(store: TagStore, color: TagColor): string {
  return store.options.find((option) => option.id === color)?.label ?? DEFAULT_TAG_LABELS[color];
}

export function colorOf(store: TagStore, color: TagColor): string {
  return store.options.find((option) => option.id === color)?.color ?? TAG_COLOR_HEX[color];
}

export function tagsOf(store: TagStore, sessionId: string | null | undefined): TagColor[] {
  return annotationsOf(store, sessionId).filter(isTagColor);
}

/** 会话行要画的那排圆点（宿主用同一份解析，确保两边顺序一致）。 */
export function tagBadgesOf(store: TagStore, sessionId: string | null | undefined): SessionAnnotationOption[] {
  return resolveAnnotationOptions(store, sessionId);
}

/**
 * 按「色槽 id / 默认名 / 当前名字」三种写法解析成一个色槽，大小写不敏感。
 *
 * 用户敲 `/tags add 红色` 与 `/tags add red` 应当等价——改成中文名之后，旧写法仍然要能
 * 命中，否则改个名字就把顺手记下的命令废掉了。
 */
export function resolveTagColor(store: TagStore, token: string): TagColor | null {
  const value = token.trim().toLowerCase();
  if (!value) return null;
  if (isTagColor(value)) return value;
  for (const color of TAG_COLORS) {
    if (DEFAULT_TAG_LABELS[color].toLowerCase() === value) return color;
    if (labelOf(store, color).toLowerCase() === value) return color;
  }
  return null;
}

/** 名字可以包含空格；优先识别完整的最长名字，再继续解析后面的颜色。 */
export function maxTagNameWords(store: TagStore): number {
  return Math.max(1, ...store.options.map((option) => option.label.trim().split(/\s+/).length));
}

export function resolveTagTokens(store: TagStore, tokens: string[]): { colors: TagColor[]; unknown: string[] } {
  const colors: TagColor[] = [];
  const unknown: string[] = [];
  const maxWords = maxTagNameWords(store);
  for (let index = 0; index < tokens.length; ) {
    let matched = false;
    for (let end = Math.min(tokens.length, index + maxWords); end > index; end -= 1) {
      const color = resolveTagColor(store, tokens.slice(index, end).join(' '));
      if (!color) continue;
      colors.push(color);
      index = end;
      matched = true;
      break;
    }
    if (!matched) unknown.push(tokens[index++]!);
  }
  return { colors, unknown };
}

export function setSessionTags(store: TagStore, sessionId: string, colors: readonly unknown[]): TagStore {
  return setSessionAnnotations(store, sessionId, colors.filter(isTagColor));
}

export function addSessionTag(store: TagStore, sessionId: string, color: TagColor): TagStore {
  if (tagsOf(store, sessionId).includes(color)) return store;
  return setSessionTags(store, sessionId, [...tagsOf(store, sessionId), color]);
}

export function removeSessionTag(store: TagStore, sessionId: string, color: TagColor): TagStore {
  const current = tagsOf(store, sessionId);
  if (!current.includes(color)) return store;
  return setSessionTags(
    store,
    sessionId,
    current.filter((item) => item !== color),
  );
}

/** 清空某个会话的标签；本来就没有标签时返回原 store。 */
export function clearSessionTags(store: TagStore, sessionId: string): TagStore {
  if (!store.assignments[sessionId]) return store;
  return setSessionTags(store, sessionId, []);
}

/** 点一下某个色槽（右键菜单的 toggle 语义，与宿主界面上的行为一致）。 */
export function toggleSessionTag(store: TagStore, sessionId: string, color: TagColor): TagStore {
  if (!isTagColor(color)) return store;
  return toggleSessionAnnotation(store, sessionId, color);
}

/** 改色槽名字。空名字或与原名相同都返回原 store（调用方据此判断有没有变）。 */
export function renameTagLabel(store: TagStore, color: TagColor, name: string): TagStore {
  const next = cleanTagLabel(name);
  if (!next || next === labelOf(store, color)) return store;
  return {
    ...store,
    options: store.options.map((option) => (option.id === color ? { ...option, label: next } : option)),
  };
}

/** 每个色槽挂着多少个会话，用于 `/tags list` 与管理面板的「0 个会话」提示。 */
export function tagCounts(store: TagStore): Record<TagColor, number> {
  const counts = Object.fromEntries(TAG_COLORS.map((color) => [color, 0])) as Record<TagColor, number>;
  for (const colors of Object.values(store.assignments)) {
    for (const color of colors) if (isTagColor(color)) counts[color] += 1;
  }
  return counts;
}

/** 第一个没有任何会话使用的色槽；7 个都用满时返回 null。 */
export function firstFreeColor(store: TagStore): TagColor | null {
  const counts = tagCounts(store);
  return TAG_COLORS.find((color) => counts[color] === 0) ?? null;
}

/** 某个色槽的展示名：改过名字就带上是哪个色槽，没改过就只显示名字。 */
export function tagLabelText(store: TagStore, color: TagColor): string {
  const label = labelOf(store, color);
  return label === DEFAULT_TAG_LABELS[color] ? label : `${label} (${color})`;
}

export function formatTagList(store: TagStore, colors: readonly TagColor[]): string {
  if (colors.length === 0) return '（无标签）';
  return colors.map((color) => tagLabelText(store, color)).join('、');
}

/** `/tags list` 与无参 `/tags` 的输出：色槽全表 + 用量。 */
export function describeTagStore(store: TagStore, sessionId?: string | null): string[] {
  const counts = tagCounts(store);
  const lines = TAG_COLORS.map((color) => `  ● ${tagLabelText(store, color)} — ${counts[color]} 个会话`);
  const current = tagsOf(store, sessionId);
  return ['会话标签（7 个固定色槽，可改名）：', ...lines, `当前会话：${formatTagList(store, current)}`];
}
