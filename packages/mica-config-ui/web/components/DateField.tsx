import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { appIcons } from '../icons.js';
import {
  buildMonthGrid,
  clampIsoDate,
  isIsoDate,
  monthLabel,
  monthOfIso,
  moveIsoDate,
  shiftMonth,
  todayIso,
} from './dateFieldModel.js';

type DateFieldProps = {
  id?: string;
  /** `YYYY-MM-DD`；空串表示还没选。 */
  value: string;
  onChange(value: string): void;
  min?: string;
  max?: string;
  ariaLabel?: string;
  /** 空值时输入框里的示例日期。 */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** `compact` 是密集工具栏 / 表格里的尺寸（24px 高、11px 字）。 */
  size?: 'default' | 'compact';
};

/**
 * 日期输入：可打字，也可以点右侧日历按钮挑。
 *
 * 为什么不用原生 `<input type="date">`：它的日历弹层由系统窗口绘制，位置、配色、
 * 关闭方式都不受页面控制，内嵌视图里会飘到控件外，和旁边的 `.text-input` 对不齐。
 * 这里用一条文本输入 + 自绘月历替掉它：键入照旧（失焦或回车时校验并夹到范围内），
 * 弹层按周一起排、键盘 ←→↑↓ 移动、Enter 选中、Esc 关闭。
 */
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
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => monthOfIso(value || todayIso()));
  const [active, setActive] = useState(value || todayIso());
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const calendarId = useId();
  const CalendarIcon = appIcons.calendar;
  const ChevronLeft = appIcons.chevronLeft;
  const ChevronRight = appIcons.chevronRight;

  // 外部改动（换了一条任务、点了「今天」）要把草稿同步过来，否则输入框还停在上一条。
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);

  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const today = todayIso();

  function commitDraft(next: string) {
    const trimmed = next.trim();
    if (!trimmed) {
      if (value) onChange('');
      return;
    }
    if (!isIsoDate(trimmed)) {
      setDraft(value);
      return;
    }
    const clamped = clampIsoDate(trimmed, min, max);
    setDraft(clamped);
    if (clamped !== value) onChange(clamped);
  }

  function openPanel() {
    if (disabled) return;
    const base = value || today;
    setCursor(monthOfIso(base));
    setActive(base);
    setOpen(true);
  }

  function pick(iso: string) {
    const clamped = clampIsoDate(iso, min, max);
    setOpen(false);
    setDraft(clamped);
    if (clamped !== value) onChange(clamped);
  }

  function move(stepDays: number) {
    const next = moveIsoDate(active, stepDays, min, max);
    setActive(next);
    setCursor(monthOfIso(next));
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        move(-1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-7);
        return;
      case 'ArrowDown':
        event.preventDefault();
        move(7);
        return;
      case 'PageUp':
        event.preventDefault();
        setCursor(shiftCursor(cursor, -1));
        return;
      case 'PageDown':
        event.preventDefault();
        setCursor(shiftCursor(cursor, 1));
        return;
      case 'Enter':
        event.preventDefault();
        pick(clampIsoDate(active, min, max));
        return;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        return;
      default:
    }
  }

  return (
    <span
      className={`ui-date${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${
        size === 'compact' ? ' is-compact' : ''
      }`}
      ref={rootRef}
    >
      <input
        id={id}
        type="text"
        className={`text-input ui-date-input${invalid ? ' text-input-invalid' : ''}`}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        inputMode="numeric"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commitDraft(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commitDraft(draft);
            setOpen(false);
          } else if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            openPanel();
          }
        }}
      />
      <button
        type="button"
        className="ui-date-trigger"
        aria-label={ariaLabel ? `选择${ariaLabel}` : '选择日期'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? calendarId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <CalendarIcon size={size === 'compact' ? 12 : 14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="ui-date-panel"
          role="dialog"
          aria-label={ariaLabel ? `${ariaLabel}：${monthLabel(cursor.year, cursor.month)}` : undefined}
          id={calendarId}
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
        >
          <div className="ui-date-head">
            <button
              type="button"
              className="ui-date-nav"
              aria-label="上个月"
              onClick={() => setCursor(shiftCursor(cursor, -1))}
            >
              <ChevronLeft size={12} aria-hidden="true" />
            </button>
            <span className="ui-date-title">{monthLabel(cursor.year, cursor.month)}</span>
            <button
              type="button"
              className="ui-date-nav"
              aria-label="下个月"
              onClick={() => setCursor(shiftCursor(cursor, 1))}
            >
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="ui-date-weekdays" aria-hidden="true">
            {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="ui-date-grid" role="grid">
            {grid.map((cell) => {
              const outside = (min && cell.iso < min) || (max && cell.iso > max);
              const classes = [
                'ui-date-day',
                cell.inMonth ? '' : 'is-outside',
                cell.iso === value ? 'is-selected' : '',
                cell.iso === active ? 'is-active' : '',
                cell.iso === today ? 'is-today' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={cell.iso}
                  type="button"
                  role="gridcell"
                  className={classes}
                  aria-selected={cell.iso === value}
                  aria-label={cell.iso}
                  disabled={Boolean(outside)}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(cell.iso)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(cell.iso)}
                >
                  {Number(cell.iso.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="ui-date-foot">
            <button type="button" className="ui-date-foot-button" onClick={() => pick(today)}>
              今天
            </button>
            {value ? (
              <button
                type="button"
                className="ui-date-foot-button"
                onClick={() => {
                  setDraft('');
                  setOpen(false);
                  onChange('');
                }}
              >
                清除
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function shiftCursor(cursor: { year: number; month: number }, delta: number) {
  return shiftMonth(cursor.year, cursor.month, delta);
}
