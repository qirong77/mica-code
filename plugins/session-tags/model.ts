/**
 * 会话标签的数据层：一份自由定义的标签表，每个标签是「名字 + 颜色 + 稳定 id」。
 *
 * 落盘用的是插件系统的通用「会话行标记」格式（`session-annotations.json`）：标签就是
 * `options`，打标就是 `assignments`。宿主因此不需要认识「标签」——它只按 options 的颜色
 * 画点、按 options 的名字生成右键菜单项。
 *
 * **这个文件必须保持零 node 依赖**：桌面端的标签页（`desktop.jsx`）要 import 它来做
 * 校验与改名，而页面打进浏览器包，任何 `node:fs` 都会让构建炸掉。读写文件在 `store.ts`。
 *
 * 几个刻意的取舍：
 * - **id 与名字、颜色解耦**：宿主只用 id 回写归属，所以改名、换色不影响已经打过标的会话。
 *   id 由插件分配（`tag-1`、`tag-2`…），不跟着名字变，中文名也照样能当标签。
 * - **顺序即渲染顺序**：会话行里那排圆点按 options 的顺序画，所以新增只能追加到末尾，
 *   同一组标签在任何会话上都按同一个顺序出现。
 * - **一个会话可以挂多个标签**，同一个标签只能出现一次。
 * - 标签**不参与侧栏归档**：Pinned / Projects / Recent 的「一个会话只在一个位置」由宿主
 *   守着，标签是跨分区的检索维度。
 */

/** 可选颜色：macOS 系统色的 7 个加上另外 5 个，深色侧栏上直接用不需要再调亮度。 */
export const TAG_PALETTE = [
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#28CD41',
  '#007AFF',
  '#AF52DE',
  '#8E8E93',
  '#FF2D55',
  '#00C7BE',
  '#30B0C7',
  '#FF6482',
  '#A2845E',
] as const;

export const DEFAULT_TAG_COLOR = TAG_PALETTE[1];

/** 新装好时的第一个标签：这是唯一会替用户预置的东西，别的都等他自己加。 */
export const SEED_TAG = { label: '待 review', color: DEFAULT_TAG_COLOR } as const;

export const MAX_TAG_LABEL_LENGTH = 24;

/** 与宿主 `sessionAnnotations` 的 MAX_OPTIONS 对齐：超出的会被宿主丢在写盘那一侧。 */
export const MAX_TAGS = 24;

/** 一个会话最多挂多少个标签（同样对齐宿主）。 */
export const MAX_TAGS_PER_SESSION = 16;

export const STORE_NAME = 'Session Tags';

export type TagOption = {
  id: string;
  label: string;
  color: string;
};

export type TagStore = {
  version: number;
  name: string;
  options: TagOption[];
  assignments: Record<string, string[]>;
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function emptyTagStore(): TagStore {
  return { version: 1, name: STORE_NAME, options: [], assignments: {} };
}

/** 首次运行落盘的那一份：只有一个「待 review」。 */
export function seedTagStore(): TagStore {
  return {
    ...emptyTagStore(),
    options: [{ id: 'tag-1', label: SEED_TAG.label, color: SEED_TAG.color }],
  };
}

/** 标签名字：去掉控制字符与多余空白，过长截断；空串表示这个输入无效。 */
export function cleanTagLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LABEL_LENGTH);
}

export function cleanTagColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : DEFAULT_TAG_COLOR;
}

/** 名字的归一化比较形式：大小写不敏感，所以 `/tags add 待Review` 也能命中。 */
export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * 把任意读到的 JSON 收敛成一份能用的标签表。
 *
 * 插件数据是公开的落盘格式（用户会手改、旧版本写过），所以一律容错：没有名字的项丢掉
 * （画不出可读的东西）、非法颜色退成默认色、归属里指向已删除标签的 id 丢掉、同一会话
 * 的标签按 options 顺序排（行内圆点位置才不跳）。
 */
export function normalizeTagStore(raw: unknown): TagStore {
  const store = emptyTagStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  const record = raw as Record<string, unknown>;

  const seen = new Set<string>();
  if (Array.isArray(record.options)) {
    for (const entry of record.options.slice(0, MAX_TAGS)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const option = entry as Record<string, unknown>;
      const id = typeof option.id === 'string' ? option.id.trim() : '';
      const label = cleanTagLabel(option.label);
      if (!id || !label || seen.has(id)) continue;
      const tag: TagOption = { id, label, color: cleanTagColor(option.color) };
      seen.add(id);
      store.options.push(tag);
    }
  }

  const order = new Map(store.options.map((option, index) => [option.id, index]));
  if (record.assignments && typeof record.assignments === 'object' && !Array.isArray(record.assignments)) {
    for (const [sessionId, ids] of Object.entries(record.assignments as Record<string, unknown>)) {
      const session = sessionId.trim();
      if (!session || !Array.isArray(ids)) continue;
      const kept = [...new Set(ids.filter((item): item is string => typeof item === 'string' && order.has(item)))];
      if (kept.length === 0) continue;
      store.assignments[session] = kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).slice(0, MAX_TAGS_PER_SESSION);
    }
  }

  return store;
}

/** 还没被占用的 id：`tag-1`、`tag-2`…，可读、可手改，也不随名字变。 */
export function nextTagId(store: TagStore): string {
  const taken = new Set(store.options.map((option) => option.id));
  for (let index = 1; index <= MAX_TAGS + 1; index += 1) {
    const id = `tag-${index}`;
    if (!taken.has(id)) return id;
  }
  return `tag-${Date.now()}`;
}

/** 页面上要显示的颜色：options 里存的就是最终值。 */
export function colorOf(store: TagStore, id: string): string {
  return store.options.find((option) => option.id === id)?.color ?? DEFAULT_TAG_COLOR;
}

export function labelOf(store: TagStore, id: string): string {
  return store.options.find((option) => option.id === id)?.label ?? id;
}

export function tagsOf(store: TagStore, sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  const ids = new Set(store.options.map((option) => option.id));
  return (store.assignments[sessionId] ?? []).filter((id) => ids.has(id));
}

export function badgesOf(store: TagStore, sessionId: string | null | undefined): TagOption[] {
  const ids = tagsOf(store, sessionId);
  return ids
    .map((id) => store.options.find((option) => option.id === id))
    .filter((option): option is TagOption => Boolean(option));
}

/** 按名字（或 id）认出一个标签，大小写不敏感。重名时取前面那个。 */
export function findTag(store: TagStore, token: string): TagOption | null {
  const value = labelKey(token);
  if (!value) return null;
  const byId = store.options.find((option) => option.id === token.trim());
  if (byId) return byId;
  return store.options.find((option) => labelKey(option.label) === value) ?? null;
}

/**
 * 命令里的多个标签名：名字可以含空格，所以按「最长能匹配上的那段」吃词。
 * 返回认出来的标签与被丢掉的词，`/tags add` 据此同时给出成功与失败两半。
 */
export function resolveTagTokens(store: TagStore, tokens: string[]): { tags: TagOption[]; unknown: string[] } {
  const tags: TagOption[] = [];
  const unknown: string[] = [];
  const maxWords = Math.max(1, ...store.options.map((option) => option.label.trim().split(/\s+/).length));
  for (let index = 0; index < tokens.length; ) {
    let matched = false;
    for (let end = Math.min(tokens.length, index + maxWords); end > index; end -= 1) {
      const tag = findTag(store, tokens.slice(index, end).join(' '));
      if (!tag) continue;
      tags.push(tag);
      index = end;
      matched = true;
      break;
    }
    if (!matched) {
      unknown.push(tokens[index]!);
      index += 1;
    }
  }
  return { tags, unknown };
}

/* ------------------------------------------------------------------ *
 * 标签表的编辑（页面与命令共用这一份校验）
 * ------------------------------------------------------------------ */

/** 一次编辑的结果：`store` 永远可用，`error` 非空表示这次没改成。 */
export type TagEdit = { store: TagStore; error?: string; id?: string };

function duplicateLabel(store: TagStore, label: string, exceptId?: string): boolean {
  const key = labelKey(label);
  return store.options.some((option) => option.id !== exceptId && labelKey(option.label) === key);
}

export function addTag(store: TagStore, input: { label: string; color?: string }): TagEdit {
  const label = cleanTagLabel(input.label);
  if (!label) return { store, error: '标签名不能为空。' };
  if (duplicateLabel(store, label)) return { store, error: `已经有叫「${label}」的标签了。` };
  if (store.options.length >= MAX_TAGS) return { store, error: `标签最多 ${MAX_TAGS} 个，先删掉几个不再用的。` };
  const id = nextTagId(store);
  return { store: { ...store, options: [...store.options, { id, label, color: cleanTagColor(input.color) }] }, id };
}

export function renameTag(store: TagStore, id: string, label: string): TagEdit {
  const next = cleanTagLabel(label);
  if (!next) return { store, error: '标签名不能为空。' };
  if (!store.options.some((option) => option.id === id)) return { store, error: '这个标签已经不存在了。' };
  if (duplicateLabel(store, next, id)) return { store, error: `已经有叫「${next}」的标签了。` };
  if (next === labelOf(store, id)) return { store };
  return {
    store: { ...store, options: store.options.map((option) => (option.id === id ? { ...option, label: next } : option)) },
  };
}

export function recolorTag(store: TagStore, id: string, color: string): TagEdit {
  if (!store.options.some((option) => option.id === id)) return { store, error: '这个标签已经不存在了。' };
  const next = cleanTagColor(color);
  if (next === colorOf(store, id)) return { store };
  return {
    store: { ...store, options: store.options.map((option) => (option.id === id ? { ...option, color: next } : option)) },
  };
}

/**
 * 删掉一个标签，同时把它从所有会话上摘掉。
 *
 * 不摘的话宿主那边会拿到指向不存在 option 的归属（`resolveAnnotationOptions` 会丢掉，
 * 但文件里会一直留着这些死 id），统计与后续手改都会对不上。
 */
export function removeTag(store: TagStore, id: string): TagEdit {
  if (!store.options.some((option) => option.id === id)) return { store, error: '这个标签已经不存在了。' };
  const options = store.options.filter((option) => option.id !== id);
  const assignments: Record<string, string[]> = {};
  for (const [sessionId, ids] of Object.entries(store.assignments)) {
    const kept = ids.filter((item) => item !== id);
    if (kept.length > 0) assignments[sessionId] = kept;
  }
  return { store: { ...store, options, assignments } };
}

/** 整份替换 options（宿主写回时走这里）：只换标签表，归属原样保留。 */
export function setTagOptions(store: TagStore, options: readonly TagOption[]): TagStore {
  return normalizeTagStore({ ...store, options });
}

/* ------------------------------------------------------------------ *
 * 会话上的打标
 * ------------------------------------------------------------------ */

export function setSessionTags(store: TagStore, sessionId: string, ids: readonly string[]): TagStore {
  const session = sessionId?.trim();
  if (!session) return store;
  const order = new Map(store.options.map((option, index) => [option.id, index]));
  const next = [...new Set(ids.filter((id) => order.has(id)))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const assignments = { ...store.assignments };
  if (next.length > 0) assignments[session] = next.slice(0, MAX_TAGS_PER_SESSION);
  else delete assignments[session];
  return { ...store, assignments };
}

export function addSessionTag(store: TagStore, sessionId: string, id: string): TagStore {
  if (tagsOf(store, sessionId).includes(id)) return store;
  return setSessionTags(store, sessionId, [...tagsOf(store, sessionId), id]);
}

export function removeSessionTag(store: TagStore, sessionId: string, id: string): TagStore {
  const current = tagsOf(store, sessionId);
  if (!current.includes(id)) return store;
  return setSessionTags(store, sessionId, current.filter((item) => item !== id));
}

/** 清空某个会话的标签；本来就没有时返回原 store。 */
export function clearSessionTags(store: TagStore, sessionId: string): TagStore {
  if (!store.assignments[sessionId]) return store;
  return setSessionTags(store, sessionId, []);
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

export function tagCounts(store: TagStore): Record<string, number> {
  const counts = Object.fromEntries(store.options.map((option) => [option.id, 0])) as Record<string, number>;
  for (const ids of Object.values(store.assignments)) {
    for (const id of ids) if (id in counts) counts[id] += 1;
  }
  return counts;
}

export function formatTagList(store: TagStore, ids: readonly string[]): string {
  if (ids.length === 0) return '（无标签）';
  return ids.map((id) => labelOf(store, id)).join('、');
}

/** `/tags` 的输出：标签全表 + 用量 + 当前会话。 */
export function describeTagStore(store: TagStore, sessionId?: string | null): string[] {
  if (store.options.length === 0) {
    return [
      '还没有任何标签。',
      '在桌面端 Settings → Plugins → Session Tags 里点「打开标签」新增（名字 + 颜色都在那里设）。',
    ];
  }
  const counts = tagCounts(store);
  const lines = store.options.map((option) => `  ● ${option.label} — ${counts[option.id] ?? 0} 个会话`);
  return [`会话标签（${store.options.length} 个）：`, ...lines, `当前会话：${formatTagList(store, tagsOf(store, sessionId))}`];
}
