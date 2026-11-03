import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { appIcons } from '../icons.js';
import {
  buildSelectMenuRows,
  filterSelectOptions,
  nextSelectMenuIndex,
  selectMenuStartIndex,
} from './selectMenuModel.js';
import type { SelectMenuOption } from './selectMenuModel.js';

export type { SelectMenuOption };

type SelectMenuProps = {
  id?: string;
  /** 当前值；空串通常是「不指定」那一项。 */
  value: string;
  options: readonly SelectMenuOption[];
  /** 当前值不在 options 里时的显示文案（例如配置里那个服务商已被删掉）。 */
  fallbackLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  /**
   * 选项多到滚不完时打开过滤框（分支名、模型名）。打开即聚焦，输入按空白拆词全命中。
   */
  filterable?: boolean;
  filterPlaceholder?: string;
  /** 过滤后没有匹配项时的文案。 */
  emptyLabel?: string;
  /**
   * 弹层最小宽度（px）。触发器常常被压得很窄，长标签在弹层里要能看全，
   * 不给就与触发器同宽。
   */
  menuMinWidth?: number;
  /** `compact` 是密集工具栏里的尺寸（24px 高、11px 字），与旁边的输入框对齐。 */
  size?: 'default' | 'compact';
  onChange(value: string): void;
};

/**
 * 自绘下拉。
 *
 * 原生 select 的弹层由系统窗口绘制：位置、圆角、勾选标记都不受页面控制，在桌面端
 * 内嵌视图里会飘到控件外、和页面风格对不上；几百个分支时还会铺满整屏。这里用一个
 * 按钮 + 绝对定位的列表替掉它，外观与 .text-input 对齐，键盘按 listbox 的习惯走
 * （↑↓ 移动、Enter/Space 选中、Esc 关闭），选项过多时打开过滤框并限高滚动。
 */
export function SelectMenu({
  id,
  value,
  options,
  fallbackLabel,
  placeholder = '未选择',
  disabled = false,
  invalid = false,
  ariaLabel,
  filterable = false,
  filterPlaceholder = '搜索',
  emptyLabel = '无匹配项',
  menuMinWidth,
  size = 'default',
  onChange,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const ChevronIcon = appIcons.chevronDown;

  const shown = useMemo(
    () => (filterable ? filterSelectOptions(options, filter) : [...options]),
    [filterable, filter, options],
  );
  const rows = useMemo(() => buildSelectMenuRows(shown), [shown]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const current = selectedIndex >= 0 ? (options[selectedIndex].label ?? options[selectedIndex].value) : undefined;
  const text = current ?? fallbackLabel ?? placeholder;

  // 收起时把过滤与高亮都清掉：每次展开都是「按当前值开始」的一屏。
  useEffect(() => {
    if (open) return;
    setActiveIndex(-1);
    setFilter('');
  }, [open]);

  // 打开过滤框时立即聚焦，用户可以直接打字。
  useEffect(() => {
    if (!open) return;
    if (filterable) {
      filterRef.current?.focus();
      return;
    }
    setActiveIndex(selectMenuStartIndex(shown, value));
  }, [open, filterable]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);

  // 键盘移动后把高亮项带进可视区；列表本身限高滚动。
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, rows]);

  function commit(index: number) {
    const option = shown[index];
    if (!option || option.disabled) return;
    setOpen(false);
    setFilter('');
    if (option.value !== value) onChange(option.value);
  }

  function move(step: number) {
    const start = activeIndex < 0 ? (filter ? -1 : selectMenuStartIndex(shown, value)) : activeIndex;
    const next = nextSelectMenuIndex(shown, start, step);
    if (next >= 0) setActiveIndex(next);
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Enter':
        event.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        else if (filter) {
          // 输入过筛选项时直接回车＝选第一条匹配，不用先按方向键。
          const first = shown.findIndex((option) => !option.disabled);
          if (first >= 0) commit(first);
        }
        return;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        return;
      default:
    }
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        if (activeIndex >= 0) commit(activeIndex);
        return;
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(nextSelectMenuIndex(shown, -1, 1));
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(nextSelectMenuIndex(shown, 0, -1));
        return;
      default:
        return;
    }
  }

  return (
    <span
      className={`ui-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${
        size === 'compact' ? ' is-compact' : ''
      }`}
      ref={rootRef}
    >
      <button
        id={id}
        type="button"
        className={`text-input ui-select-trigger${invalid ? ' text-input-invalid' : ''}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`ui-select-value${current ? '' : ' is-placeholder'}`}>{text}</span>
        <ChevronIcon className="ui-select-chevron" size={size === 'compact' ? 12 : 14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="ui-select-menu" style={menuMinWidth ? { minWidth: menuMinWidth } : undefined}>
          {filterable ? (
            <div className="ui-select-filter">
              <input
                ref={filterRef}
                type="text"
                className="ui-select-filter-input"
                value={filter}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  setFilter(event.target.value);
                  setActiveIndex(-1);
                }}
                onKeyDown={onMenuKeyDown}
              />
            </div>
          ) : null}
          <div className="ui-select-list" role="listbox" id={listId} aria-label={ariaLabel} ref={listRef}>
            {rows.length === 0 ? (
              <div className="ui-select-empty">{emptyLabel}</div>
            ) : (
              rows.map((row) =>
                row.kind === 'group' ? (
                  <div key={`group-${row.label}`} className="ui-select-group" role="presentation">
                    {row.label}
                  </div>
                ) : (
                  <div
                    key={`${row.option.value}-${row.index}`}
                    data-index={row.index}
                    role="option"
                    aria-selected={row.option.value === value}
                    className={`ui-select-option${
                      row.option.value === value ? ' is-selected' : ''
                    }${row.index === activeIndex ? ' is-active' : ''}${row.option.disabled ? ' is-disabled' : ''}`}
                    title={row.option.label ?? row.option.value}
                    onMouseEnter={() => setActiveIndex(row.index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commit(row.index)}
                  >
                    <span className="ui-select-option-text">{row.option.label ?? row.option.value}</span>
                    {row.option.value === value ? (
                      <span className="ui-select-check" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </div>
                ),
              )
            )}
          </div>
        </div>
      ) : null}
    </span>
  );
}
