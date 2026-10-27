/**
 * 会话标签的纯数据层：7 个固定色槽（照 macOS Finder 的彩色圆点），每个色槽有一个可改的
 * 名字，会话与色槽是多对多。
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

export const TAGS_STORE_VERSION = 1;

export type TagStore = {
  version: number;
  /** 色槽 id -> 用户给它起的名字。7 个键永远齐全。 */
  labels: Record<TagColor, string>;
  /** 会话 id -> 它挂着的色槽（按色序去重）。没有标签的会话不占键。 */
  assignments: Record<string, TagColor[]>;
};

export function emptyTagStore(): TagStore {
  return { version: TAGS_STORE_VERSION, labels: { ...DEFAULT_TAG_LABELS }, assignments: {} };
}

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

export function tagColorIndex(color: TagColor): number {
  return TAG_COLORS.indexOf(color);
}

/**
 * 把任意读到的 JSON 收敛成一份能用的 store。
 *
 * 磁盘上的文件可能被手改过、也可能是旧版本写的：未知色槽、重复项、非字符串名字一律丢掉，
 * 缺的色槽补默认名。解析失败**不抛错**——标签坏掉不该让会话起不来。
 */
export function normalizeTagStore(raw: unknown): TagStore {
  const store = emptyTagStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;

  const record = raw as Record<string, unknown>;
  const labels = record.labels;
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    for (const color of TAG_COLORS) {
      const value = (labels as Record<string, unknown>)[color];
      if (typeof value !== 'string') continue;
      const name = cleanTagLabel(value);
      if (name) store.labels[color] = name;
    }
  }

  const assignments = record.assignments;
  if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
    for (const [sessionId, colors] of Object.entries(assignments as Record<string, unknown>)) {
      const id = sessionId.trim();
      if (!id || !Array.isArray(colors)) continue;
      const normalized = normalizeColorList(colors);
      if (normalized.length > 0) store.assignments[id] = normalized;
    }
  }

  return store;
}

/** 色槽名字：去掉控制字符与多余空白，过长截断；空串表示这次改名无效。 */
export function cleanTagLabel(value: string): string {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.slice(0, MAX_TAG_LABEL_LENGTH);
}

/** 去重并按色序排列；未知色槽丢弃。 */
export function normalizeColorList(values: readonly unknown[]): TagColor[] {
  const seen = new Set<TagColor>();
  for (const value of values) if (isTagColor(value)) seen.add(value);
  return [...seen].sort((a, b) => tagColorIndex(a) - tagColorIndex(b));
}

export function tagsOf(store: TagStore, sessionId: string | null | undefined): TagColor[] {
  if (!sessionId) return [];
  return store.assignments[sessionId] ?? [];
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
    if (store.labels[color].toLowerCase() === value) return color;
  }
  return null;
}

/** 设置某个会话的标签集合（整组替换）。空集合等于清空，并从文件里删掉这个键。 */
export function setSessionTags(store: TagStore, sessionId: string, colors: readonly unknown[]): TagStore {
  const id = sessionId.trim();
  if (!id) return store;
  const next = normalizeColorList(colors);
  const assignments = { ...store.assignments };
  if (next.length > 0) assignments[id] = next;
  else delete assignments[id];
  return { ...store, assignments };
}

export function addSessionTag(store: TagStore, sessionId: string, color: TagColor): TagStore {
  const current = tagsOf(store, sessionId);
  if (current.includes(color)) return store;
  return setSessionTags(store, sessionId, [...current, color]);
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

/** 改色槽名字。空名字或与原名相同都返回原 store（调用方据此判断有没有变）。 */
export function renameTagLabel(store: TagStore, color: TagColor, name: string): TagStore {
  const next = cleanTagLabel(name);
  if (!next || next === store.labels[color]) return store;
  return { ...store, labels: { ...store.labels, [color]: next } };
}

/** 每个色槽挂着多少个会话，用于 `/tags list` 与管理面板的「0 个会话」提示。 */
export function tagCounts(store: TagStore): Record<TagColor, number> {
  const counts = Object.fromEntries(TAG_COLORS.map((color) => [color, 0])) as Record<TagColor, number>;
  for (const colors of Object.values(store.assignments)) {
    for (const color of colors) counts[color] += 1;
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
  const label = store.labels[color];
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
  return [
    '会话标签（7 个固定色槽，可改名）：',
    ...lines,
    `当前会话：${formatTagList(store, current)}`,
  ];
}
