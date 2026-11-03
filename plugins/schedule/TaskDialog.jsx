import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Alert, Button, DateField, Tag } from '@mica-config-ui/web';
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
  const formRef = useRef(null);
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

  /** 共享 `Button` 只产出 `type="button"`：保存仍走表单提交，回车提交与校验都留在 `submit` 里。 */
  function submitForm() {
    formRef.current?.requestSubmit();
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
        ref={formRef}
        onSubmit={submit}
        className="flex max-h-[min(86vh,640px)] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-[13px] font-semibold text-fg-max">{task ? '编辑任务' : '新建任务'}</h2>
          <Button variant="ghost" icon={<X size={14} />} title="关闭" onClick={onClose} />
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
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submitForm();
                }
              }}
              placeholder="比如：钱包改版 / 联调 / 上线"
              maxLength={60}
              className="text-input"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div className="block">
              <span className="mb-1 block text-[11px] text-fg-soft">开始</span>
              <DateField
                value={startDate}
                ariaLabel="开始"
                onChange={(next) => {
                  setStartDate(next);
                  if (next && endDate < next) setEndDate(next);
                }}
              />
            </div>
            <div className="block">
              <span className="mb-1 block text-[11px] text-fg-soft">结束</span>
              <DateField
                value={endDate}
                min={startDate}
                ariaLabel="结束"
                onChange={(next) => {
                  setEndDate(next && next >= startDate ? next : startDate);
                }}
              />
            </div>
          </div>
          <div className="-mt-1.5 flex items-center gap-2 text-[10px] text-fg-dim">
            {days > 0 ? <Tag tone="blue">{`共 ${days} 天（含首尾）`}</Tag> : '选好起止日期'}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] text-fg-soft">颜色</span>
              <span className="text-[10px] text-fg-dim">
                {COLOR_META[hoverColor ?? color].label} · 同色的任务排在同一行
              </span>
            </div>
            {/* 色块是数据（任务的颜色本身），按钮还要接 hover 换标签与逐色圆点样式，
                共享 Button 只暴露 onClick，所以这一排保留原生按钮。 */}
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

          {error && <Alert message={error} />}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">
          {task && (
            <Button variant={confirmDelete ? 'danger' : 'ghost'} icon={<Trash2 size={13} />} onClick={armDelete}>
              {confirmDelete ? '确认删除' : '删除'}
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submitForm}>
            {task ? '保存' : '添加'}
          </Button>
        </div>
      </form>
    </div>
  );
}
