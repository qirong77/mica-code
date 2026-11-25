import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { ToolGroupEntry, ToolParameterEntry } from './registry.js';

/**
 * `$MICA_HOME/plugin-tools.json`：插件工具的目录投影。
 *
 * 为什么需要它：插件工具只有在**装配了插件的宿主**里才存在（`ctx.tools.register()` 发生在
 * setup 时）。配置页 / 桌面设置页这些不加载插件的进程拿不到注册表，于是「新会话默认值」
 * 里看不到 `subagent_*` 这类插件工具，也就没法在这里开关它们。`RUNTIME_TOOL_DESCRIPTORS`
 * 只能手写覆盖少数几个通用工具，插件自己的一整族工具没法逐条维护。
 *
 * 与 `tool-icons.json` 一样是派生缓存：装配过的宿主把注册表投影成这份文件，读的一方合并进
 * 自己的目录；不做数据迁移，删掉会自动重建。
 *
 * 写盘按插件合并：同一台机器上可能同时有 TUI、桌面主进程、每会话一个 `app-server`，
 * 各自装配的插件并不完全相同（`desktop` 相关插件只在桌面宿主里装上）。整份覆盖会让
 * 最后写的那份把别人的工具抹掉，所以本进程只替换「自己装配过的插件」那几组条目。
 */
export const TOOL_CATALOG_PROJECTION_FILE = 'plugin-tools.json';

export type ToolCatalogProjectionEntry = {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: ToolParameterEntry[];
  /** 插件工具的归属组（`plugin:<id>`）；内核工具没有归属时为 null。 */
  group: ToolGroupEntry | null;
  /** 注册它的插件 id；读的一方据此按启停状态过滤。 */
  pluginId?: string;
  icon?: string;
};

export type ToolCatalogProjection = {
  version: 1;
  tools: ToolCatalogProjectionEntry[];
};

export function toolCatalogProjectionPath(configDir: string = resolveMicaHome()): string {
  return join(configDir, TOOL_CATALOG_PROJECTION_FILE);
}

/** 上一次写盘的内容，按路径记：同一份内容重复写没有意义。 */
const lastWritten = new Map<string, string>();

/**
 * 读投影。文件不存在（还没跑过装配插件的宿主）或内容坏掉时返回空表——界面据此只是少几行
 * 插件工具，不该因为一份缓存文件把整个目录弄崩。
 */
export function readToolCatalogProjection(configDir: string = resolveMicaHome()): ToolCatalogProjectionEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(toolCatalogProjectionPath(configDir), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.tools)) return [];
    return record.tools.flatMap((entry) => normalizeEntry(entry));
  } catch {
    return [];
  }
}

/**
 * 合并写投影：本进程装配的插件（`entries` 里出现过的 pluginId）整组替换，其余插件的条目
 * 保持原样。内容与上一次相同就跳过写盘。
 *
 * `ownedPluginIds` 补上「这个进程曾经发布过、现在一个工具都不剩」的插件——插件停用后
 * 它那一组条目必须跟着消失，否则界面会把已经关掉的工具继续列出来。
 */
export function writeToolCatalogProjection(
  entries: readonly ToolCatalogProjectionEntry[],
  configDir: string = resolveMicaHome(),
  options: { ownedPluginIds?: Iterable<string> } = {},
): boolean {
  const owned = new Set(options.ownedPluginIds ?? []);
  for (const entry of entries) {
    if (entry.pluginId) owned.add(entry.pluginId);
  }
  const merged = new Map<string, ToolCatalogProjectionEntry>();
  for (const entry of readToolCatalogProjection(configDir)) {
    if (entry.pluginId && owned.has(entry.pluginId)) continue;
    merged.set(entry.name, entry);
  }
  for (const entry of entries) merged.set(entry.name, entry);
  const tools = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const body = `${JSON.stringify({ version: 1, tools } satisfies ToolCatalogProjection, null, 2)}\n`;
  const path = toolCatalogProjectionPath(configDir);
  if (lastWritten.get(path) === body) return false;
  try {
    writeTextFileAtomic(path, body);
    lastWritten.set(path, body);
    return true;
  } catch {
    // 投影只是给不加载插件的界面补目录行：写不进去不该影响工具运行。
    return false;
  }
}

/** 测试用：让「上次写了什么」跟着临时目录一起重置。 */
export function resetToolCatalogProjectionCache(): void {
  lastWritten.clear();
}

function normalizeEntry(value: unknown): ToolCatalogProjectionEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return [];
  if (typeof record.description !== 'string') return [];
  const group =
    record.group && typeof record.group === 'object' && !Array.isArray(record.group)
      ? normalizeGroup(record.group as Record<string, unknown>)
      : null;
  const pluginId =
    typeof record.pluginId === 'string' && record.pluginId.trim()
      ? record.pluginId
      : group?.key.startsWith('plugin:')
        ? group.key.slice('plugin:'.length)
        : undefined;
  return [
    {
      name: record.name,
      description: record.description,
      readOnly: record.readOnly === true,
      parameters: Array.isArray(record.parameters) ? record.parameters.flatMap(normalizeParameter) : [],
      group,
      ...(pluginId ? { pluginId } : {}),
      ...(typeof record.icon === 'string' && record.icon.trim() ? { icon: record.icon } : {}),
    },
  ];
}

function normalizeGroup(record: Record<string, unknown>): ToolGroupEntry | null {
  if (typeof record.key !== 'string' || !record.key.trim()) return null;
  return { key: record.key, label: typeof record.label === 'string' ? record.label : record.key };
}

function normalizeParameter(value: unknown): ToolParameterEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return [];
  return [
    {
      name: record.name,
      type: typeof record.type === 'string' ? record.type : 'any',
      required: record.required === true,
      description: typeof record.description === 'string' ? record.description : '',
    },
  ];
}
