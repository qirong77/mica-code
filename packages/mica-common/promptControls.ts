/** Global prompt customizations, applied when a new turn starts. */
export type PromptControls = {
  version: 1;
  disabledPlugins: string[];
  sections: Record<string, { enabled?: boolean; content?: string }>;
  /**
   * 用户拖拽出来的段落顺序（只放可编辑段落，`system` 永远固定在最前）。
   *
   * 不在列表里的段落排在已列出的段落之后、彼此保持原有相对顺序：新插件注册的段落
   * 因此默认落到末尾，不会被塞进用户已经排好的序列中间。
   */
  order?: string[];
};

export type PromptSectionSnapshot = {
  id: string;
  label: string;
  pluginId?: string;
  sectionId?: string;
  originalContent: string;
  content: string;
  enabled: boolean;
  editable: boolean;
};

export type RuntimePromptInspection = {
  cwd: string;
  role: string;
  running: boolean;
  /** Preview using the current global controls; changes take effect next turn. */
  preview: string;
  lastSent: string | null;
  sections: PromptSectionSnapshot[];
};

export function promptSectionKey(pluginId: string, sectionId: string): string {
  return `plugin:${pluginId}/${sectionId}`;
}

/**
 * 按用户顺序排列段落；没有自定义顺序时原样返回，保证不使用该功能时提示词前缀不变。
 *
 * `system` 是只读基底且要留在稳定前缀里，无论顺序表怎么写都排在最前。
 */
export function orderPromptSections<T extends { id: string }>(sections: T[], order?: string[]): T[] {
  if (!order?.length) return sections;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...sections].sort((left, right) => {
    if (left.id === 'system' || right.id === 'system') return left.id === 'system' ? -1 : 1;
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}
