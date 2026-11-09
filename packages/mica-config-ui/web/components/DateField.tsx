import { useRef, useState } from 'react';
import DatePicker from '@arco-design/web-react/es/DatePicker';
import '../arco-settings.css';
import { clampIsoDate, isIsoDate } from './dateFieldModel.js';

type DateFieldProps = {
  id?: string;
  value: string;
  onChange(value: string): void;
  min?: string;
  max?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'default' | 'compact';
};

export function DateField({
  id,
  value,
  onChange,
  min,
  max,
  ariaLabel,
  placeholder = 'YYYY-MM-DD',
  disabled = false,
  invalid = false,
  size = 'default',
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const typed = useRef<string | null>(null);

  function commit(next: string | undefined) {
    const trimmed = next?.trim() ?? '';
    if (trimmed && !isIsoDate(trimmed)) return;
    const date = trimmed ? clampIsoDate(trimmed, min, max) : '';
    if (date !== value) onChange(date);
  }

  return (
    <span
      className={`ui-date ui-date-arco${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${
        size === 'compact' ? ' is-compact' : ''
      }`}
      onInputCapture={(event) => {
        if (event.target instanceof HTMLInputElement) typed.current = event.target.value;
      }}
      onBlurCapture={(event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        commit(event.target.value);
      }}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        if (event.key === 'Tab') {
          commit(typed.current ?? event.target.value);
          typed.current = null;
          setOpen(false);
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          commit(event.target.value);
          typed.current = null;
          setOpen(false);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          typed.current = null;
          setOpen(false);
        } else if (event.key === 'ArrowDown' && !disabled) {
          setOpen(true);
        }
      }}
    >
      <DatePicker
        className="ui-date-input"
        value={isIsoDate(value) ? value : undefined}
        format="YYYY-MM-DD"
        dayStartOfWeek={1}
        size={size === 'compact' ? 'mini' : 'small'}
        placeholder={placeholder}
        disabled={disabled}
        status={invalid ? 'error' : undefined}
        editable
        allowClear
        popupVisible={open}
        onVisibleChange={(visible) => {
          if (!visible && typed.current !== null) {
            commit(typed.current);
            typed.current = null;
          }
          setOpen(!!visible);
        }}
        inputProps={{ id, 'aria-label': ariaLabel, 'aria-invalid': invalid || undefined, inputMode: 'numeric' }}
        disabledDate={(date) => {
          const iso = date.format('YYYY-MM-DD');
          return !!((min && iso < min) || (max && iso > max));
        }}
        getPopupContainer={(node) => node.closest('.mica-config-ui') ?? node.parentElement ?? node}
        onChange={(next) => {
          typed.current = null;
          commit(next);
        }}
      />
    </span>
  );
}
