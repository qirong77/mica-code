import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 会话行标记（session annotations）。
 *
 * 插件想让自己的状态出现在**会话列表**上（标签色点、优先级、审阅状态……）时，不必让宿主
 * 认识这个概念：把一份 `session-annotations.json` 写到自己的数据目录里，宿主只认这份
 * 通用结构，按 `options` 里给的颜色画点、按 `options` 里的名字做菜单项。
 *
 * 宿主里因此没有「标签」这个词——它只知道「某个插件给这些会话挂了 these options 中的几个」。
 * 换一个插件写同样的文件，界面一样能画，这是「能力面通用」而非「为一个插件写死」的关键。
 *
 * 文件位置：`$MICA_HOME/plugin-data/<pluginId>/session-annotations.json`
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "Session Tags",
 *   "options": [{ "id": "red", "label": "阻塞", "color": "#FF3B30" }],
 *   "assignments": { "<sessionId>": ["red"] }
 * }
 * ```
 *
 * 约定：
 * - `options[].id` 是插件自己的稳定键（颜色槽 id / 优先级 id），`label` 是给人看的名字（可为空，
 *   读的一方自己决定退化为什么），
 *   `color` 是圆点颜色（`#RRGGBB`）。**宿主只用 id 回写**，名字与颜色只是展示。
 * - 一个会话可挂多个 option；顺序即渲染顺序，插件负责保持稳定（不要按点击顺序）。
 * - 某个 option 被插件删掉后，assignments 里的残留 id 由读的一方（`resolveAnnotationOptions`）
 *   丢掉，不需要迁移代码。归一化时刻意**不删**这些 id：options 有可能只是暂时缺了一段
 *   （插件先写归属、后补色板；或用户手改文件），在这里删等于把用户数据一起删了。
 */

export const PLUGIN_DATA_DIR = 'plugin-data';
export const SESSION_ANNOTATIONS_FILE = 'session-annotations.json';
export const SESSION_ANNOTATIONS_VERSION = 1;

export type SessionAnnotationOption = {
  id: string;
  label: string;
  /** `#RRGGBB`；非法颜色退化成灰色，绝不丢整个 option。 */
  color: string;
};

export type SessionAnnotations = {
  version: number;
  name: string;
  options: SessionAnnotationOption[];
  assignments: Record<string, string[]>;
};

/** 宿主视角的一份数据：多带一个来源插件 id，回写时要用它定位文件。 */
export type SessionAnnotationsProvider = SessionAnnotations & { pluginId: string };

const FALLBACK_COLOR = '#8E8E93';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_OPTIONS = 24;
const MAX_ASSIGNED = 16;

export function emptySessionAnnotations(name = 'Annotations'): SessionAnnotations {
  return { version: SESSION_ANNOTATIONS_VERSION, name, options: [], assignments: {} };
}

/** 插件数据目录：`$MICA_HOME/plugin-data/<pluginId>`。 */
export function pluginDataDir(home: string, pluginId: string): string {
  return join(home, PLUGIN_DATA_DIR, pluginId);
}

export function sessionAnnotationsPath(home: string, pluginId: string): string {
  return join(pluginDataDir(home, pluginId), SESSION_ANNOTATIONS_FILE);
}

/**
 * 收敛任意读到的 JSON。
 *
 * 插件数据是公开的落盘格式，用户会手改、也会被旧版本写过，所以这里一律容错：非法的
 * option 丢掉、非法颜色退灰、assignments 里不存在的 id 清掉、重复项去掉。解析失败**不抛错**，
 * 一个坏的标记文件不该让侧栏崩掉。
 */
export function normalizeSessionAnnotations(raw: unknown, fallbackName = 'Annotations'): SessionAnnotations {
  const data = emptySessionAnnotations(fallbackName);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return data;

  const record = raw as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.trim()) data.name = record.name.trim().slice(0, 40);

  const seen = new Set<string>();
  if (Array.isArray(record.options)) {
    for (const entry of record.options.slice(0, MAX_OPTIONS)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const option = entry as Record<string, unknown>;
      const id = typeof option.id === 'string' ? option.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      data.options.push({
        id,
        // 空名字原样留空，由渲染的一侧决定退化成什么（宿主用 id、标签插件用默认色名）。
        // 这里若代填 id，插件就分不出「用户没命名」和「用户就叫这个」。
        label: typeof option.label === 'string' ? option.label.trim().slice(0, 24) : '',
        color: typeof option.color === 'string' && HEX_COLOR.test(option.color)
          ? option.color
          : FALLBACK_COLOR,
      });
    }
  }

  if (record.assignments && typeof record.assignments === 'object' && !Array.isArray(record.assignments)) {
    for (const [sessionId, ids] of Object.entries(record.assignments as Record<string, unknown>)) {
      const id = sessionId.trim();
      if (!id || !Array.isArray(ids)) continue;
      const kept = [
        ...new Set(
          ids.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          ),
        ),
      ];
      if (kept.length > 0) data.assignments[id] = kept.slice(0, MAX_ASSIGNED);
    }
  }

  return data;
}

/** 某个会话挂了哪些 option id（按文件里的顺序）。 */
export function annotationsOf(data: SessionAnnotations | null | undefined, sessionId: string | null | undefined): string[] {
  if (!data || !sessionId) return [];
  return data.assignments[sessionId] ?? [];
}

/** 把 option id 解析成宿主能画的 option 对象；未知 id 丢掉。 */
export function resolveAnnotationOptions(
  data: SessionAnnotations | null | undefined,
  sessionId: string | null | undefined,
): SessionAnnotationOption[] {
  if (!data) return [];
  const byId = new Map(data.options.map((option) => [option.id, option]));
  return annotationsOf(data, sessionId)
    .map((id) => byId.get(id))
    .filter((option): option is SessionAnnotationOption => Boolean(option));
}

/** 整组替换某个会话的 option（保持 options 的定义顺序，位置才不跳）。 */
export function setSessionAnnotations(
  data: SessionAnnotations,
  sessionId: string,
  ids: readonly string[],
): SessionAnnotations {
  const id = sessionId?.trim();
  if (!id) return data;
  const order = new Map(data.options.map((option, index) => [option.id, index]));
  const next = [...new Set(ids.filter((item) => order.has(item)))].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const assignments = { ...data.assignments };
  if (next.length > 0) assignments[id] = next;
  else delete assignments[id];
  return { ...data, assignments };
}

/** 点一下某个 option：有就去掉，没有就加上（右键菜单的 toggle 语义）。 */
export function toggleSessionAnnotation(
  data: SessionAnnotations,
  sessionId: string,
  optionId: string,
): SessionAnnotations {
  const current = annotationsOf(data, sessionId);
  const next = current.includes(optionId)
    ? current.filter((item) => item !== optionId)
    : [...current, optionId];
  return setSessionAnnotations(data, sessionId, next);
}

/** 每个 option 挂着多少会话，用于菜单里的用量提示。 */
export function annotationCounts(data: SessionAnnotations | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const option of data?.options ?? []) counts[option.id] = 0;
  for (const ids of Object.values(data?.assignments ?? {})) {
    for (const id of ids) if (id in counts) counts[id] += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * 磁盘读写
 * ------------------------------------------------------------------ */

export function readSessionAnnotations(home: string, pluginId: string): SessionAnnotations {
  const file = sessionAnnotationsPath(home, pluginId);
  try {
    return normalizeSessionAnnotations(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // 文件不存在或坏掉：当作「这个插件还没有标记」。插件自己会把默认 options 写回去。
    return emptySessionAnnotations();
  }
}

export function writeSessionAnnotations(home: string, pluginId: string, data: SessionAnnotations): void {
  const file = sessionAnnotationsPath(home, pluginId);
  mkdirSync(pluginDataDir(home, pluginId), { recursive: true });
  // 先写临时文件再 rename：宿主与插件可能同时读，不能让它读到半份 JSON。
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...data, version: SESSION_ANNOTATIONS_VERSION }, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * 汇总所有插件的标记数据（宿主用）。
 *
 * 只返回「有 options」的提供者：没有色板的文件画不出任何东西，列进侧栏只会多一层空菜单。
 * 目录名即 pluginId，回写时用它定位文件，所以这里不接受文件里自称的 id。
 */
export function readAllSessionAnnotations(home: string): SessionAnnotationsProvider[] {
  const root = join(home, PLUGIN_DATA_DIR);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const providers: SessionAnnotationsProvider[] = [];
  for (const pluginId of entries.sort()) {
    const file = join(root, pluginId, SESSION_ANNOTATIONS_FILE);
    try {
      if (!existsSync(file)) continue;
      const data = normalizeSessionAnnotations(JSON.parse(readFileSync(file, 'utf8')));
      if (data.options.length === 0) continue;
      providers.push({ ...data, pluginId });
    } catch {
      continue;
    }
  }
  return providers;
}

/** 文件是否真的存在（宿主用它区分「插件没装」与「装了但还没打标」）。 */
export function sessionAnnotationsExists(home: string, pluginId: string): boolean {
  try {
    statSync(sessionAnnotationsPath(home, pluginId));
    return true;
  } catch {
    return false;
  }
}
