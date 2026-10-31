import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { addDays, daysBetween } from './dates.js';
import { COLOR_KEYS, COLOR_META } from './palette.js';
import { NoteEditor } from './NoteEditor.jsx';

/**
 * 新建 / 编辑一条任务。
 *
 * 交互对齐参考项目：改动都在这一个弹窗里完成（名称、起止、颜色、Markdown 备注），
 * 关掉即保存；删除要点两次，避免在时间轴上误删。
 */
export function TaskDialog({ task, draft, onSave, onDelete, onClose }) {
  const start = task?.start ?? draft?.start ?? draft?.today ?? '';
  const [name, setName] = useState(task?.name ?? '');
  const [startDate, setStartDate] = useState(start);
  const [endDate, setEndDate] = useState(task?.end ?? draft?.end ?? (start ? addDays(start, 4) : ''));
  const [color, setColor] = useState(task?.color ?? draft?.color ?? 'blue');
  const [hoverColor, setHoverColor] = useState(null);
  const [note, setNote] = useState(task?.note ?? '');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef(null);
  const confirmTimer = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  function submit(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('先给这条任务起个名字');
      nameRef.current?.focus();
      return;
    }
    if (!startDate) {
      setError('开始日期不能为空');
      return;
    }
    const end = endDate && endDate >= startDate ? endDate : startDate;
    onSave({
      name: trimmed,
      start: startDate,
      end,
      color,
      note: note.trim(),
    });
  }

  function armDelete() {
    if (!task) return;
    if (confirmDelete) {
      onDelete();
      return;
    }
    setConfirmDelete(true);
    confirmTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000);
  }

  const days = startDate && endDate ? daysBetween(startDate, endDate) + 1 : 0;

  return (
    <div
      className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="flex max-h-[min(86vh,640px)] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-[13px] font-semibold text-fg-max">{task ? '编辑任务' : '新建任务'}</h2>
          <button
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1 block text-[11px] text-fg-soft">任务名称</span>
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              ref={nameRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError('');
              }}
              placeholder="比如：钱包改版 / 联调 / 上线"
              maxLength={60}
              className="h-8 w-full rounded-md border border-line bg-canvas px-2.5 text-[13px] text-fg-strong outline-none placeholder:text-fg-dim focus:border-line-strong"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-soft">开始</span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!next) return;
                  setStartDate(next);
                  if (endDate < next) setEndDate(next);
                }}
                className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-soft">结束</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!next) return;
                  setEndDate(next < startDate ? startDate : next);
                }}
                className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
              />
            </label>
          </div>
          <div className="-mt-1.5 text-[10px] text-fg-dim">{days > 0 ? `共 ${days} 天（含首尾）` : '选好起止日期'}</div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] text-fg-soft">颜色</span>
              <span className="text-[10px] text-fg-dim">
                {COLOR_META[hoverColor ?? color].label} · 同色的任务排在同一行
              </span>
            </div>
            <div className="flex items-center gap-2">
              {COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  title={COLOR_META[key].label}
                  aria-label={COLOR_META[key].label}
                  aria-pressed={color === key}
                  onMouseEnter={() => setHoverColor(key)}
                  onMouseLeave={() => setHoverColor(null)}
                  onClick={() => setColor(key)}
                  className={`grid size-6 place-items-center rounded-full border border-line transition-transform hover:scale-110 ${
                    color === key ? 'ring-2 ring-fg-max/60 ring-offset-2 ring-offset-panel' : ''
                  }`}
                >
                  <span className={`size-4 rounded-full ${COLOR_META[key].dot}`} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1 block text-[11px] text-fg-soft">备注</span>
            <NoteEditor value={note} onChange={setNote} placeholder="写点背景、依赖或验收标准…" ariaLabel="任务备注" />
          </div>

          {error && <div className="text-[11px] text-danger">{error}</div>}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
          {task && (
            <button
              type="button"
              onClick={armDelete}
              className={`flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] transition-colors ${
                confirmDelete
                  ? 'border-danger/60 bg-danger/10 text-danger'
                  : 'border-line text-fg-muted hover:border-line-strong hover:text-danger'
              }`}
            >
              <Trash2 size={12} />
              {confirmDelete ? '确认删除' : '删除'}
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 items-center rounded-md border border-line px-3 text-[11px] text-fg-soft hover:border-line-strong hover:text-fg-max"
          >
            取消
          </button>
          <button
            type="submit"
            className="flex h-7 items-center rounded-md border border-line-strong bg-overlay-subtle px-3 text-[11px] font-medium text-fg-max hover:bg-overlay"
          >
            {task ? '保存' : '添加'}
          </button>
        </div>
      </form>
    </div>
  );
}
