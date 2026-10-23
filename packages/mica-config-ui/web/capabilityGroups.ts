/**
 * 能力列表的分组与按组开关。
 *
 * 设置页与会话设置弹窗共用这一份：同一个工具族（`pty_*`、`session_*` 等）在两端都按组
 * 展示、按组开关，结算方式也只在这里定义。分组本身来自工具目录（`getCatalog()` 的
 * `group`），客户端只负责排版与批量改写禁用名单。
 */

export type CapabilityGroupRef = { key: string; label: string };

/** 分组只要求名字与可选 group，技能与 MCP 服务器没有 group，按原样单独成行。 */
export type CapabilityGroupable = {
  name: string;
  group?: CapabilityGroupRef | null;
};

export type CapabilitySection<T extends CapabilityGroupable> = {
  /** 分组键；未分组的项用 `null`，渲染时直接平铺。 */
  key: string | null;
  label: string | null;
  items: T[];
  enabledCount: number;
  /** 全部启用 / 全部关闭 / 部分启用；组开关按它决定下一次点击的方向。 */
  state: 'all' | 'none' | 'partial';
};

/**
 * 按分组键归并（不要求同组成员相邻），顺序沿用工具名的字典序。
 *
 * 只有共享前缀的工具族（`pty_*` 等）才带 `group`，它们在字典序里本来就相邻；按 key
 * 归并是为了不依赖目录的排序细节。独立工具（没有 `group`）就地单独成行，不聚到末尾。
 */
export function buildCapabilitySections<T extends CapabilityGroupable>(
  items: T[],
  isEnabled: (name: string) => boolean
): CapabilitySection<T>[] {
  const sections: CapabilitySection<T>[] = [];
  const byKey = new Map<string, CapabilitySection<T>>();
  for (const item of items) {
    const group = item.group ?? null;
    if (!group) {
      sections.push({ key: null, label: null, items: [item], enabledCount: 0, state: 'none' });
      continue;
    }
    const existing = byKey.get(group.key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const section: CapabilitySection<T> = {
      key: group.key,
      label: group.label,
      items: [item],
      enabledCount: 0,
      state: 'none',
    };
    byKey.set(group.key, section);
    sections.push(section);
  }
  for (const section of sections) {
    section.enabledCount = section.items.filter((item) => isEnabled(item.name)).length;
    section.state =
      section.enabledCount === 0
        ? 'none'
        : section.enabledCount === section.items.length
          ? 'all'
          : 'partial';
  }
  return sections;
}

/** 组开关下一次点击的目标状态：全开就关，其他情况一律全开。 */
export function nextGroupEnabled(state: CapabilitySection<CapabilityGroupable>['state']): boolean {
  return state !== 'all';
}

/**
 * 批量改写禁用名单：组内全部启用 = 从名单移除，全部关闭 = 全部写入。
 *
 * 名单里存的是工具名而不是组名——能力校验按工具名逐条判定，组只是一次批量操作；
 * 之后新增进同一组的工具保持默认启用，不会被历史开关牵连。
 */
export function applyGroupEnabled(disabledNames: string[], names: string[], enabled: boolean): string[] {
  if (enabled) {
    const drop = new Set(names);
    return disabledNames.filter((name) => !drop.has(name));
  }
  return [...new Set([...disabledNames, ...names])];
}
