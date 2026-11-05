import { readFileSync } from 'node:fs';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { sessionAnnotationsPath, writeSessionAnnotations } from '@packages/mica-plugin/sessionAnnotations.js';
import { normalizeTagStore, seedTagStore, type TagStore } from './model.js';

/**
 * 标签表的落盘。
 *
 * 文件就是插件系统的通用「会话行标记」（`$MICA_HOME/plugin-data/session-tags/session-annotations.json`），
 * 所以宿主那一侧（侧栏圆点、右键菜单、设置页）不需要认识标签这个概念。这里只做三件事：
 * 定位文件、把读到的内容收敛成 `TagStore`、原子写回。
 *
 * 归一化与所有编辑规则都在 `model.ts`（那里零 node 依赖，桌面端的标签页共用同一份）。
 */

export function annotationsFile(home: string | undefined, pluginId: string): string {
  return sessionAnnotationsPath(home ?? resolveMicaHome(), pluginId);
}

/** 文件不存在时返回 `undefined`（区别于「存在但内容被清空」）。 */
export function readRawStore(file: string): unknown {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('标签文件格式不正确');
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeStore(home: string | undefined, pluginId: string, store: TagStore): void {
  writeSessionAnnotations(home ?? resolveMicaHome(), pluginId, store);
}

/**
 * 启动时要落盘的那一份，`dirty` 表示文件需要重写。
 *
 * 两件事在启动时定下来：
 * - **文件不存在**（第一次跑这个插件）就预置一个「待 review」。文件存在但标签被删空
 *   则什么都不做——再长一个出来，用户会以为删不掉。
 * - 文件里有归一化会丢掉的东西（指向已删标签的死 id、乱序的归属、非法颜色）就写回
 *   收敛版本。宿主读的是文件本身、不走这里的归一化，不写回的话界面上还会显示那些
 *   本该消失的标签。
 *
 * 旧版本的固定色槽不在这里处理：那是数据形态的变化，由 `evolution` 插件在启动时
 * 一次性迁走（见 `plugins/evolution/data/session-tags.ts`）。
 */
export function resolveStore(raw: unknown): { store: TagStore; dirty: boolean } {
  if (raw === undefined) return { store: seedTagStore(), dirty: true };
  const store = normalizeTagStore(raw);
  return { store, dirty: !sameTable(raw, store) };
}

/** 文件里描述出来的标签集与归属，是否已经就是收敛后的样子。 */
function sameTable(raw: unknown, store: TagStore): boolean {
  const record = (raw ?? {}) as Record<string, unknown>;
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  if (rawOptions.length !== store.options.length) return false;
  for (let index = 0; index < store.options.length; index += 1) {
    const option = rawOptions[index] as Record<string, unknown> | undefined;
    const tag = store.options[index]!;
    if (option?.id !== tag.id || option?.label !== tag.label || option?.color !== tag.color) return false;
  }

  const rawAssignments = (record.assignments ?? {}) as Record<string, unknown>;
  const rawSessions = Object.entries(rawAssignments).filter(([, ids]) => Array.isArray(ids) && ids.length > 0);
  if (rawSessions.length !== Object.keys(store.assignments).length) return false;
  for (const [sessionId, ids] of Object.entries(store.assignments)) {
    const rawIds = rawAssignments[sessionId];
    if (!Array.isArray(rawIds) || rawIds.length !== ids.length) return false;
    if (rawIds.some((value, index) => value !== ids[index])) return false;
  }
  return true;
}
