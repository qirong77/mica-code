/**
 * `SelectMenu` 的纯逻辑：选项过滤、分组、键盘移动。
 *
 * 拆出来是因为下拉的行为（尤其几百个分支时按输入过滤、跳过禁用项）必须能单测，
 * 而组件本身只有渲染。
 */

export type SelectMenuOption = {
  value: string;
  label?: string;
  disabled?: boolean;
  /** 同一组的标题只在组内第一项前画一次；不给分组就是一条普通列表。 */
  group?: string;
};

export type SelectMenuGroupHeader = {
  kind: 'group';
  label: string;
};

export type SelectMenuGroupItem = {
  kind: 'option';
  option: SelectMenuOption;
  /** 过滤后的下标：键盘高亮与 `data-index` 都用它。 */
  index: number;
};

export type SelectMenuRow = SelectMenuGroupHeader | SelectMenuGroupItem;

function optionText(option: SelectMenuOption): string {
  return `${option.label ?? option.value}\n${option.value}`;
}

/**
 * 按输入过滤选项：忽略大小写的子串匹配，标签与值都参与。
 *
 * 分支名这类长文本靠 `a/b/c` 的分段匹配找不到（用户只会输入其中一段），所以按
 * 空白拆成多个词，全部命中才算匹配；顺序保持原样，过滤不重排。
 */
export function filterSelectOptions(options: readonly SelectMenuOption[], query: string): SelectMenuOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const text = optionText(option).toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** 把过滤后的选项摊平成「分组标题 + 选项」的行，供渲染与高度估算使用。 */
export function buildSelectMenuRows(options: readonly SelectMenuOption[]): SelectMenuRow[] {
  const rows: SelectMenuRow[] = [];
  let group: string | undefined;
  options.forEach((option, index) => {
    if (option.group && option.group !== group) {
      rows.push({ kind: 'group', label: option.group });
    }
    group = option.group;
    rows.push({ kind: 'option', option, index });
  });
  return rows;
}

/**
 * 从 `from` 出发按 `step` 找下一个可选项；没有可选项时返回 -1。
 *
 * `from` 传 -1 表示「还没高亮」：向下从第一项开始，向上从最后一项开始。
 */
export function nextSelectMenuIndex(options: readonly SelectMenuOption[], from: number, step: number): number {
  const total = options.length;
  if (total === 0) return -1;
  const dir = step >= 0 ? 1 : -1;
  let index = from < 0 ? (dir > 0 ? 0 : total - 1) : from;
  for (let tries = 0; tries < total; tries += 1) {
    // `from < 0` 时第一轮就看起点本身，其余情况先迈步再看。
    if (from >= 0 || tries > 0) index = (index + dir + total) % total;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** 展开时的高亮起点：当前选中项，找不到就第一项。 */
export function selectMenuStartIndex(options: readonly SelectMenuOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value && !option.disabled);
  if (index >= 0) return index;
  return nextSelectMenuIndex(options, -1, 1);
}
