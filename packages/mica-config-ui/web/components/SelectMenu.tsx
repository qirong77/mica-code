import { useEffect, useId, useRef, useState } from 'react';
import { appIcons } from '../icons.js';

export type SelectMenuOption = {
  value: string;
  label?: string;
  disabled?: boolean;
};

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
  onChange(value: string): void;
};

/**
 * 自绘下拉。
 *
 * 原生 select 的弹层由 macOS 窗口系统绘制：位置、圆角、勾选标记都不受页面控制，在桌面端
 * 内嵌视图里会飘到控件外、和页面风格对不上。这里用一个按钮 + 绝对定位的列表替掉它，
 * 外观与 .text-input 对齐，键盘也按 listbox 的习惯走（↑↓ 移动、Enter/Space 选中、Esc 关闭）。
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
  onChange,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const ChevronIcon = appIcons.chevronDown;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const current = selectedIndex >= 0 ? (options[selectedIndex].label ?? options[selectedIndex].value) : undefined;
  const text = current ?? fallbackLabel ?? placeholder;

  // 收起时不需要记住高亮位置：每次展开都从当前值那一项开始。
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

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
  }, [open, activeIndex]);

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }

  function move(step: number) {
    if (options.length === 0) return;
    const from = activeIndex < 0 ? (selectedIndex >= 0 ? selectedIndex : 0) : activeIndex + step;
    let next = from;
    for (let tries = 0; tries < options.length; tries += 1) {
      next = (next + options.length) % options.length;
      if (!options[next].disabled) break;
      next += step >= 0 ? 1 : -1;
      next = (next + options.length) % options.length;
    }
    setActiveIndex(next);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) setOpen(true);
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        commit(activeIndex >= 0 ? activeIndex : selectedIndex);
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
        setActiveIndex(0);
        return;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      default:
        return;
    }
  }

  return (
    <span className={`ui-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
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
        onKeyDown={onKeyDown}
      >
        <span className={`ui-select-value${current ? '' : ' is-placeholder'}`}>{text}</span>
        <ChevronIcon className="ui-select-chevron" size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="ui-select-menu" role="listbox" id={listId} aria-label={ariaLabel} ref={listRef}>
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <div
                key={`${option.value}-${index}`}
                data-index={index}
                role="option"
                aria-selected={selected}
                className={`ui-select-option${selected ? ' is-selected' : ''}${
                  index === activeIndex ? ' is-active' : ''
                }${option.disabled ? ' is-disabled' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(index)}
              >
                <span className="ui-select-option-text">{option.label ?? option.value}</span>
                {selected ? (
                  <span className="ui-select-check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
