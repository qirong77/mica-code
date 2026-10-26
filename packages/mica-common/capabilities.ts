import { normalizeToolName } from './toolNames.js';

/**
 * 会话级能力选择（skills / tools / MCP servers）。
 *
 * 只保存「被关掉的名字」，其余一律视为启用：新增的 skill、工具或 MCP server
 * 默认可用，不需要旧会话跟着迁移。CLI 与 desktop 共用这份模型与解析规则，
 * 具体的可用集合仍由各自的注册表 / 扫描结果提供。
 */
export type CapabilitySelection = {
  version: 1;
  disabledSkills: string[];
  disabledTools: string[];
  disabledMcpServers: string[];
};

export const CAPABILITY_SELECTION_VERSION = 1;

export function emptyCapabilitySelection(): CapabilitySelection {
  return { version: CAPABILITY_SELECTION_VERSION, disabledSkills: [], disabledTools: [], disabledMcpServers: [] };
}

function normalizeNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 工具名走一遍历史别名映射：改名前的会话关掉的工具，升级后仍保持关闭。 */
function normalizeToolNameList(value: unknown): string[] {
  return normalizeNameList((Array.isArray(value) ? value : []).map(normalizeToolName));
}

/** 解析任意持久化值；缺失或损坏时退回「全部启用」。 */
export function normalizeCapabilitySelection(value: unknown): CapabilitySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCapabilitySelection();
  const record = value as Partial<CapabilitySelection>;
  return {
    version: CAPABILITY_SELECTION_VERSION,
    disabledSkills: normalizeNameList(record.disabledSkills),
    disabledTools: normalizeToolNameList(record.disabledTools),
    disabledMcpServers: normalizeNameList(record.disabledMcpServers),
  };
}

export function cloneCapabilitySelection(selection: CapabilitySelection): CapabilitySelection {
  return {
    version: CAPABILITY_SELECTION_VERSION,
    disabledSkills: [...selection.disabledSkills],
    disabledTools: [...selection.disabledTools],
    disabledMcpServers: [...selection.disabledMcpServers],
  };
}

export type CapabilityKind = 'skills' | 'tools' | 'mcpServers';

type DisabledListKey = 'disabledSkills' | 'disabledTools' | 'disabledMcpServers';

const DISABLED_KEY: Record<CapabilityKind, DisabledListKey> = {
  skills: 'disabledSkills',
  tools: 'disabledTools',
  mcpServers: 'disabledMcpServers',
};

export function isCapabilityEnabled(selection: CapabilitySelection, kind: CapabilityKind, name: string): boolean {
  return !selection[DISABLED_KEY[kind]].includes(name);
}

export function setCapabilityEnabled(
  selection: CapabilitySelection,
  kind: CapabilityKind,
  name: string,
  enabled: boolean,
): CapabilitySelection {
  const key = DISABLED_KEY[kind];
  const current = new Set(selection[key]);
  if (enabled) current.delete(name);
  else current.add(name);
  return { ...cloneCapabilitySelection(selection), [key]: [...current] } as CapabilitySelection;
}

export function setAllCapabilitiesEnabled(
  selection: CapabilitySelection,
  kind: CapabilityKind,
  names: string[],
  enabled: boolean,
): CapabilitySelection {
  const key = DISABLED_KEY[kind];
  const current = new Set(selection[key]);
  for (const name of names) {
    if (enabled) current.delete(name);
    else current.add(name);
  }
  return { ...cloneCapabilitySelection(selection), [key]: [...current] } as CapabilitySelection;
}

export function capabilityCounts(
  selection: CapabilitySelection,
  kind: CapabilityKind,
  names: string[],
): { enabled: number; total: number } {
  const disabled = new Set(selection[DISABLED_KEY[kind]]);
  return { enabled: names.filter((name) => !disabled.has(name)).length, total: names.length };
}

export function isCapabilitySelectionEmpty(selection: CapabilitySelection): boolean {
  return (
    selection.disabledSkills.length === 0 &&
    selection.disabledTools.length === 0 &&
    selection.disabledMcpServers.length === 0
  );
}

export function capabilitySelectionEquals(a: CapabilitySelection, b: CapabilitySelection): boolean {
  const same = (left: string[], right: string[]) => {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((name, index) => name === sortedRight[index]);
  };
  return (
    same(a.disabledSkills, b.disabledSkills) &&
    same(a.disabledTools, b.disabledTools) &&
    same(a.disabledMcpServers, b.disabledMcpServers)
  );
}
