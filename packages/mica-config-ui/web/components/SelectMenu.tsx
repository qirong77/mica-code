import { useState, type ReactNode } from 'react';
import Select from '@arco-design/web-react/es/Select';
import '../arco-settings.css';
import { filterSelectOptions } from './selectMenuModel.js';
import type { SelectMenuOption } from './selectMenuModel.js';

export type { SelectMenuOption };

type SelectMenuProps = {
  id?: string;
  value: string;
  options: readonly SelectMenuOption[];
  fallbackLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  filterable?: boolean;
  filterPlaceholder?: string;
  emptyLabel?: string;
  menuMinWidth?: number;
  size?: 'default' | 'compact';
  className?: string;
  onChange(value: string): void;
};

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
  className,
  onChange,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const groups: { group?: string; options: ReactNode[] }[] = [];
  options.forEach((option, index) => {
    if (!groups.length || groups[groups.length - 1].group !== option.group) {
      groups.push({ group: option.group, options: [] });
    }
    groups[groups.length - 1].options.push(
      <Select.Option key={`${option.value}-${index}`} value={option.value} disabled={option.disabled}>
        {option.label ?? option.value}
      </Select.Option>,
    );
  });

  return (
    <span
      className={`ui-select ui-select-arco${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${
        size === 'compact' ? ' is-compact' : ''
      }${className ? ` ${className}` : ''}`}
    >
      <Select
        id={id}
        className="ui-select-trigger"
        value={value}
        size={size === 'compact' ? 'mini' : 'small'}
        disabled={disabled}
        status={invalid ? 'error' : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        placeholder={open && filterable ? filterPlaceholder : placeholder}
        showSearch={filterable}
        filterOption={(query, option) => {
          const source = options.find((item) => item.value === (option.props as { value: string }).value);
          return !!source && filterSelectOptions([source], query).length > 0;
        }}
        renderFormat={() => (selected ? (selected.label ?? selected.value) : (fallbackLabel ?? placeholder))}
        notFoundContent={<div className="ui-select-empty">{emptyLabel}</div>}
        dropdownMenuClassName={`ui-select-arco-menu${size === 'compact' ? ' is-compact' : ''}`}
        dropdownMenuStyle={menuMinWidth ? { minWidth: menuMinWidth } : undefined}
        triggerProps={menuMinWidth ? { autoAlignPopupMinWidth: true, autoAlignPopupWidth: false } : undefined}
        getPopupContainer={(node) => node.closest('.mica-config-ui') ?? node.parentElement ?? node}
        onVisibleChange={setOpen}
        onChange={(next: string) => {
          if (next !== value && !options.find((option) => option.value === next)?.disabled) onChange(next);
        }}
      >
        {groups.map((group, index) =>
          group.group ? (
            <Select.OptGroup key={index} label={group.group}>
              {group.options}
            </Select.OptGroup>
          ) : (
            group.options
          ),
        )}
      </Select>
    </span>
  );
}
