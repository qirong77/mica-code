import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Download, Plus, Sparkles, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { addDays, daysBetween, todayOf } from './dates.js';
import {
  BAR_HEIGHT,
  LANE_GAP,
  ROW_PADDING,
  SCALES,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  axisCells,
  buildGantt,
  clampZoom,
  isWeekend,
  rowHeight,
  scaleSpec,
  todayScrollLeft,
  zoomAnchor,
} from './gantt.js';
import { COLOR_META, nextColor } from './palette.js';
import {
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
  applyOperation,
  emptyData,
  exportDocument,
  newId,
  normalizeData,
  normalizeTitle,
  parseImport,
  sampleData,
  stamp,
} from './schedule.js';
import { describeWhen, shortDate, spanDays } from './view.js';
import { createScheduleWriter } from './writer.js';
import { TaskDialog } from './TaskDialog.jsx';

/**
 * 排期整页：一份本地甘特图。
 *
 * 交互与参考项目对齐：任务平铺、同色一行；空白处点/拖新建，拖条改期，点条编辑；
 * 名称、起止、颜色与 Markdown 备注都在一个弹窗里改。写盘不整份覆盖，而是排一条操作
 *（见 writer.ts），所以另一个窗口或模型同时改别的任务时不会互相覆盖。
 */

const REFRESH_MS = 15_000;
const DRAG_THRESHOLD = 4;
const MAJOR_HEADER_HEIGHT = 24;
const MINOR_HEADER_HEIGHT = 22;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function raf(callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback);
  } else {
    callback();
  }
}

export default function SchedulePage({ api }) {
  const [data, setData] = useState(() => emptyData());
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState('');
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [zoom, setZoom] = useState(1);
  const [today, setToday] = useState(() => todayOf());
  const [dialog, setDialog] = useState(null);
  const [creating, setCreating] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const [toast, setToast] = useState(null);
  const [armedClear, setArmedClear] = useState(false);

  const dataRef = useRef(data);
  const hostRef = useRef(null);
  const wheelRef = useRef({ delta: 0, timer: null });
  const rowsRef = useRef(null);
  const fileRef = useRef(null);
  const dialogRef = useRef(dialog);
  const dialogSeqRef = useRef(0);
  const createRef = useRef(null);
  const dragRef = useRef(null);
  const dragPreviewRef = useRef(null);
  const pendingRef = useRef(0);
  const refreshingRef = useRef(false);
  const pollVersionRef = useRef(null);
  const didScrollRef = useRef(false);
  const scrollToTodayRef = useRef(() => {});
  const toastTimerRef = useRef(null);
  const clearTimerRef = useRef(null);
  const titleRef = useRef(title);
  const titleDirtyRef = useRef(false);
  const titleTimerRef = useRef(null);

  dataRef.current = data;
  dialogRef.current = dialog;
  dragPreviewRef.current = dragPreview;
  titleRef.current = title;

  const showToast = useCallback((message, tone = 'ok') => {
    setToast({ message, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const writer = useMemo(
    () =>
      createScheduleWriter({
        host: api,
        onError: (message) => {
          setSaveState('error');
          setSaveError(message);
          showToast(message, 'error');
        },
      }),
    [api, showToast],
  );

  const load = useCallback(
    async (options = {}) => {
      if (!options.quiet) {
        setStatus('loading');
        setLoadError('');
      }
      try {
        const result = await api.readData();
        if (result?.ok === false) throw new Error(result.error || '读取排期失败');
        const parsed = result?.value == null ? emptyData() : normalizeData(result.value);
        dataRef.current = parsed;
        setData(parsed);
        if (!titleDirtyRef.current) {
          setTitle(parsed.title);
          titleRef.current = parsed.title;
        }
        pollVersionRef.current = result?.version ?? null;
        setStatus('ready');
        setSaveState('idle');
        setSaveError('');
      } catch (error) {
        setLoadError(errorText(error));
        setStatus('error');
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayOf()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      if (titleTimerRef.current) window.clearTimeout(titleTimerRef.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    if (
      saveState === 'error' ||
      writer.pending() > 0 ||
      dialogRef.current ||
      createRef.current ||
      dragRef.current ||
      titleDirtyRef.current
    )
      return;
    refreshingRef.current = true;
    try {
      const result = await api.readData();
      if (result?.ok === false) return;
      const version = result?.version ?? null;
      if (version === pollVersionRef.current) return;
      const parsed = result?.value == null ? emptyData() : normalizeData(result.value);
      pollVersionRef.current = version;
      dataRef.current = parsed;
      setData(parsed);
      if (!titleDirtyRef.current) {
        setTitle(parsed.title);
        titleRef.current = parsed.title;
      }
    } catch {
      // 轮询失败不打扰用户：下一次再试，真正的错误在保存时会有反馈
    } finally {
      refreshingRef.current = false;
    }
  }, [api, writer, saveState]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const commit = useCallback(
    (operation) => {
      let next;
      try {
        next = stamp(applyOperation(dataRef.current, operation));
      } catch (error) {
        showToast(errorText(error), 'error');
        void load({ quiet: true });
        return false;
      }
      dataRef.current = next;
      setData(next);
      pendingRef.current += 1;
      setSaveState('saving');
      setSaveError('');
      writer.push(operation);
      void writer.flush().then((ok) => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (!ok) {
          setSaveState('error');
          return;
        }
        if (pendingRef.current === 0) {
          setSaveState('idle');
          setSaveError('');
        }
      });
      return true;
    },
    [writer, showToast, load],
  );

  const retrySave = useCallback(async () => {
    setSaveState('saving');
    setSaveError('');
    const ok = await writer.flush();
    if (!ok) {
      setSaveState('error');
      return;
    }
    await load({ quiet: true });
    setSaveState('idle');
  }, [writer, load]);

  const tasks = data.tasks;
  const scale = data.scale;
  const layout = useMemo(() => buildGantt(tasks, { today }), [tasks, today]);
  const cells = useMemo(() => axisCells(layout.start, layout.days, scale), [layout.start, layout.days, scale]);
  const pxPerDay = scaleSpec(scale).pxPerDay * zoom;
  const width = Math.max(320, layout.days * pxPerDay);
  const rowsHeight = layout.rows.reduce((sum, row) => sum + rowHeight(row.lanes), 0);
  const todayOffset = daysBetween(layout.start, today);
  const todayInAxis = todayOffset >= 0 && todayOffset < layout.days;

  const scrollToToday = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    host.scrollLeft = todayScrollLeft(layout.start, today, pxPerDay, host.clientWidth);
  }, [layout.start, today, pxPerDay]);
  scrollToTodayRef.current = scrollToToday;

  useEffect(() => {
    if (status !== 'ready' || didScrollRef.current) return;
    didScrollRef.current = true;
    raf(() => scrollToTodayRef.current());
  }, [status]);

  const lastScaleRef = useRef(scale);
  useEffect(() => {
    if (lastScaleRef.current === scale) return;
    lastScaleRef.current = scale;
    raf(() => scrollToTodayRef.current());
  }, [scale]);

  /* ------------------------------------------------------------ 标题 */

  const persistTitle = useCallback(() => {
    if (!titleDirtyRef.current) return;
    titleDirtyRef.current = false;
    const next = normalizeTitle(titleRef.current);
    if (next !== titleRef.current) {
      titleRef.current = next;
      setTitle(next);
    }
    if (next === dataRef.current.title) return;
    commit({ type: 'update-title', title: next });
  }, [commit]);

  function changeTitle(value) {
    const next = value.slice(0, MAX_TITLE_LENGTH);
    setTitle(next);
    titleRef.current = next;
    titleDirtyRef.current = true;
    if (titleTimerRef.current) window.clearTimeout(titleTimerRef.current);
    titleTimerRef.current = window.setTimeout(() => {
      titleTimerRef.current = null;
      persistTitle();
    }, 700);
  }

  function commitTitleNow() {
    if (titleTimerRef.current) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    persistTitle();
  }

  /* ------------------------------------------------------------ 缩放 / 滚动 */

  const applyZoom = useCallback(
    (nextZoom, anchorClientX) => {
      const clamped = clampZoom(nextZoom);
      if (Math.abs(clamped - zoom) < 0.0001) return;
      const host = hostRef.current;
      if (!host) {
        setZoom(clamped);
        return;
      }
      const rect = host.getBoundingClientRect();
      const anchorX = anchorClientX == null ? host.clientWidth / 2 : anchorClientX - rect.left;
      const nextScroll = zoomAnchor({
        start: layout.start,
        scrollLeft: host.scrollLeft,
        pxPerDay,
        scale,
        zoom: clamped,
        anchorX,
        viewportWidth: host.clientWidth,
      }).scrollLeft;
      setZoom(clamped);
      raf(() => {
        if (hostRef.current) hostRef.current.scrollLeft = nextScroll;
      });
    },
    [zoom, layout.start, pxPerDay, scale],
  );

  function onWheel(event) {
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (horizontal) {
      const host = hostRef.current;
      if (!host) return;
      event.preventDefault();
      host.scrollLeft += event.deltaX || event.deltaY;
      return;
    }
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    const wheel = wheelRef.current;
    wheel.delta += delta;
    window.clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(() => {
      wheel.delta = 0;
    }, 180);
    if (Math.abs(wheel.delta) < 60) return;
    const steps = Math.trunc(wheel.delta / 60);
    wheel.delta -= steps * 60;
    applyZoom(zoom * (steps > 0 ? 1 / 1.2 : 1.2), event.clientX);
  }

  /* ------------------------------------------------------------ 拖动 / 框选 */

  function dayIndexAt(clientX) {
    const rect = rowsRef.current?.getBoundingClientRect();
    if (!rect || pxPerDay <= 0) return null;
    const raw = (clientX - rect.left) / pxPerDay;
    if (raw < 0 || raw >= layout.days) return null;
    return Math.floor(raw);
  }

  function startCreate(event) {
    if (event.button !== 0) return;
    const index = dayIndexAt(event.clientX);
    if (index == null) return;
    const anchor = addDays(layout.start, index);
    createRef.current = { anchor, current: anchor, startX: event.clientX, moved: false };
    setCreating({ from: anchor, to: anchor });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveCreate(event) {
    const state = createRef.current;
    if (!state) return;
    if (Math.abs(event.clientX - state.startX) > 3) state.moved = true;
    const index = dayIndexAt(event.clientX);
    if (index == null) return;
    const date = addDays(layout.start, index);
    if (date === state.current) return;
    state.current = date;
    const from = date < state.anchor ? date : state.anchor;
    const to = date < state.anchor ? state.anchor : date;
    setCreating({ from, to });
  }

  function endCreate() {
    const state = createRef.current;
    if (!state) return;
    createRef.current = null;
    setCreating(null);
    const from = state.current < state.anchor ? state.current : state.anchor;
    const to = state.current < state.anchor ? state.anchor : state.current;
    openCreateDialog(from, to);
  }

  function cancelCreate() {
    createRef.current = null;
    setCreating(null);
  }

  function startDrag(event, bar) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = Math.min(8, Math.max(2, rect.width / 3));
    const mode = event.clientX - rect.left <= edge ? 'start' : rect.right - event.clientX <= edge ? 'end' : 'move';
    dragRef.current = {
      taskId: bar.taskId,
      mode,
      startX: event.clientX,
      originStart: bar.start,
      originEnd: bar.end,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveDrag(event) {
    const state = dragRef.current;
    if (!state) return;
    if (!state.moved && Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD) return;
    state.moved = true;
    const delta = Math.round((event.clientX - state.startX) / pxPerDay);
    let start = state.originStart;
    let end = state.originEnd;
    if (state.mode === 'move') {
      start = addDays(state.originStart, delta);
      end = addDays(state.originEnd, delta);
    } else if (state.mode === 'start') {
      start = addDays(state.originStart, delta);
      if (start > end) start = end;
    } else {
      end = addDays(state.originEnd, delta);
      if (end < start) end = start;
    }
    const next = {
      taskId: state.taskId,
      start,
      end,
      offset: daysBetween(layout.start, start),
      span: daysBetween(start, end) + 1,
      moved: true,
    };
    dragPreviewRef.current = next;
    setDragPreview(next);
  }

  function endDrag() {
    const state = dragRef.current;
    dragRef.current = null;
    const preview = dragPreviewRef.current;
    dragPreviewRef.current = null;
    setDragPreview(null);
    if (!state) return;
    if (!state.moved) {
      openEditDialog(state.taskId);
      return;
    }
    if (!preview) return;
    if (preview.start === state.originStart && preview.end === state.originEnd) return;
    commit({ type: 'update-task', taskId: state.taskId, start: preview.start, end: preview.end });
  }

  function cancelDrag() {
    dragRef.current = null;
    dragPreviewRef.current = null;
    setDragPreview(null);
  }

  /* ------------------------------------------------------------ 弹窗 */

  function openCreateDialog(start, end) {
    dialogSeqRef.current += 1;
    setDialog({
      seq: dialogSeqRef.current,
      draft: { start, end, color: nextColor(dataRef.current.tasks.length) },
    });
  }

  function openEditDialog(taskId) {
    if (!dataRef.current.tasks.some((task) => task.id === taskId)) return;
    dialogSeqRef.current += 1;
    setDialog({ seq: dialogSeqRef.current, taskId });
  }

  function saveTask(values) {
    const current = dialogRef.current;
    if (!current) return;
    if (current.taskId) {
      commit({ type: 'update-task', taskId: current.taskId, ...values });
    } else {
      commit({ type: 'add-task', task: { id: newId(), ...values } });
    }
    setDialog(null);
  }

  function deleteTask() {
    const current = dialogRef.current;
    if (!current?.taskId) return;
    commit({ type: 'delete-task', taskId: current.taskId });
    setDialog(null);
  }

  const dialogTask = dialog?.taskId ? (tasks.find((task) => task.id === dialog.taskId) ?? null) : null;

  /* ------------------------------------------------------------ 工具栏动作 */

  function changeScale(next) {
    if (next === scale) return;
    commit({ type: 'update-scale', scale: next });
  }

  function loadSample() {
    const next = sampleData(today);
    commit({ type: 'replace', title: next.title, scale: next.scale, tasks: next.tasks });
    showToast('已载入示例');
    raf(() => scrollToTodayRef.current());
  }

  function exportJson() {
    const documentValue = exportDocument(dataRef.current);
    const blob = new Blob([JSON.stringify(documentValue, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(dataRef.current.title || DEFAULT_TITLE).replace(/[\\/:*?"<>|]/g, '')}-${today}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('已导出 JSON 备份');
  }

  async function importJson(file) {
    try {
      const parsed = parseImport(JSON.parse(await file.text()));
      commit({ type: 'replace', title: parsed.title, scale: parsed.scale, tasks: parsed.tasks });
      showToast(`已导入 ${parsed.tasks.length} 个任务`);
      raf(() => scrollToTodayRef.current());
    } catch (error) {
      showToast(`导入失败：${errorText(error)}`, 'error');
    }
  }

  function clearAll() {
    if (!armedClear) {
      setArmedClear(true);
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = window.setTimeout(() => setArmedClear(false), 3000);
      return;
    }
    setArmedClear(false);
    commit({ type: 'clear-tasks' });
    showToast('已清空任务（不可撤销）');
  }

  /* ------------------------------------------------------------ 渲染 */

  const saveStatus =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'error'
        ? '保存失败，点此重试'
        : status === 'ready'
          ? '已保存'
          : '数据未同步';

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="z-30 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-overlay text-fg-soft">
            <CalendarDays size={15} />
          </span>
          <input
            aria-label="排期名称"
            value={title}
            onChange={(event) => changeTitle(event.target.value)}
            onBlur={commitTitleNow}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setTitle(dataRef.current.title);
                titleRef.current = dataRef.current.title;
                titleDirtyRef.current = false;
                event.currentTarget.blur();
              }
            }}
            maxLength={MAX_TITLE_LENGTH}
            className="h-6 w-[9rem] rounded-sm border border-transparent bg-transparent px-1 text-[13px] font-semibold text-fg-max outline-none transition-colors hover:border-line focus:border-line-strong focus:bg-canvas sm:w-[14rem]"
          />
          {saveState === 'error' ? (
            <button
              type="button"
              title={saveError}
              onClick={() => void retrySave()}
              className="hidden shrink-0 text-[10px] text-danger underline-offset-2 hover:underline sm:inline"
            >
              {saveStatus}
            </button>
          ) : (
            <span className="hidden shrink-0 text-[10px] text-fg-dim sm:inline">{saveStatus}</span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center rounded-md border border-line bg-canvas p-0.5">
            {SCALES.map((item) => (
              <button
                key={item.key}
                type="button"
                title={`${item.label}视角`}
                aria-pressed={scale === item.key}
                onClick={() => changeScale(item.key)}
                className={`h-6 rounded-sm px-2 text-[11px] transition-colors ${
                  scale === item.key ? 'bg-overlay text-fg-max shadow-sm' : 'text-fg-muted hover:text-fg-max'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              title="缩小时间轴（滚轮向下也行）"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => applyZoom(zoom / ZOOM_STEP, null)}
              className="grid size-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max disabled:opacity-40"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              title="恢复默认缩放"
              onClick={() => applyZoom(1, null)}
              className="h-6 min-w-[40px] rounded-sm text-[10px] tabular-nums text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="放大时间轴（滚轮向上也行）"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => applyZoom(zoom * ZOOM_STEP, null)}
              className="grid size-6 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max disabled:opacity-40"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          <button
            type="button"
            title="回到今天"
            onClick={() => scrollToTodayRef.current()}
            className="flex h-7 items-center rounded-md border border-line px-2.5 text-[11px] text-fg-soft transition-colors hover:border-line-strong hover:text-fg-max"
          >
            今天
          </button>

          <button
            type="button"
            title="新建任务"
            onClick={() => openCreateDialog(today, addDays(today, 4))}
            className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-overlay-subtle px-2.5 text-[11px] font-medium text-fg-max transition-colors hover:bg-overlay"
          >
            <Plus size={12} />
            新增任务
          </button>

          <div className="flex items-center">
            <button
              type="button"
              title="导出 JSON"
              onClick={exportJson}
              className="grid size-7 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max"
            >
              <Download size={13} />
            </button>
            <button
              type="button"
              title="导入 JSON"
              onClick={() => fileRef.current?.click()}
              className="grid size-7 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max"
            >
              <Upload size={13} />
            </button>
            <button
              type="button"
              title={armedClear ? '确认清空全部任务' : '清空全部任务'}
              onClick={clearAll}
              className={`grid size-7 place-items-center rounded-sm transition-colors ${
                armedClear ? 'bg-danger/10 text-danger' : 'text-fg-muted hover:bg-overlay hover:text-danger'
              }`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </header>

      {status === 'loading' ? (
        <div className="grid min-h-0 flex-1 place-items-center text-xs text-fg-muted">正在读取排期…</div>
      ) : status === 'error' ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <div className="max-w-sm text-center">
            <p className="text-[13px] text-fg-strong">读取排期失败</p>
            <p className="mt-1 break-words text-[11px] leading-5 text-danger">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 inline-flex h-7 items-center rounded-md border border-line-strong px-3 text-[11px] text-fg-strong hover:text-fg-max"
            >
              重试
            </button>
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border border-dashed border-line-strong bg-panel/40 p-6 text-center">
            <p className="text-[13px] font-medium text-fg-max">还没有任务</p>
            <p className="mt-1.5 text-xs leading-5 text-fg-muted">
              {
                '点「新增任务」开始排期（默认从今天起共 5 天）；也可以在时间轴空白处点一下按那天新建、横向拖一段按选中区间新建。拖住任务条中间可以整体平移，拖两端改起止日期。'
              }
            </p>
            <p className="mt-1 text-[11px] leading-5 text-fg-dim">
              {
                '滚轮缩放时间轴（Shift + 滚轮横向平移）；点任务条编辑名称、颜色与 Markdown 备注。同色的任务自动排在同一行，时间不重叠的上下共享一行。'
              }
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                title="新建任务"
                onClick={() => openCreateDialog(today, addDays(today, 4))}
                className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-overlay-subtle px-3 text-[11px] font-medium text-fg-max hover:bg-overlay"
              >
                <Plus size={12} />
                新增任务
              </button>
              <button
                type="button"
                title="载入示例"
                onClick={loadSample}
                className="flex h-7 items-center gap-1 rounded-md border border-line px-3 text-[11px] text-fg-soft hover:border-line-strong hover:text-fg-max"
              >
                <Sparkles size={12} />
                载入示例
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div ref={hostRef} className="relative min-h-0 flex-1 overflow-auto" onWheel={onWheel}>
          <div style={{ width, minWidth: '100%' }}>
            <div className="sticky top-0 z-20 bg-panel/95 backdrop-blur">
              <div className="relative border-b border-line-soft" style={{ height: MAJOR_HEADER_HEIGHT }}>
                {cells.major.map((cell) => (
                  <div
                    key={`major-${cell.offset}`}
                    className="absolute top-0 flex h-full items-center overflow-hidden border-r border-line-soft px-1.5 text-[10px] text-fg-muted"
                    style={{ left: cell.offset * pxPerDay, width: cell.span * pxPerDay }}
                  >
                    {cell.label}
                  </div>
                ))}
                {todayInAxis && (
                  <span
                    className="absolute top-0 flex h-full items-center text-[10px] font-medium text-info"
                    style={{ left: todayOffset * pxPerDay + 3 }}
                  >
                    今天
                  </span>
                )}
              </div>
              <div className="relative border-b border-line" style={{ height: MINOR_HEADER_HEIGHT }}>
                {cells.minor.map((cell) => (
                  <div
                    key={`minor-${cell.offset}`}
                    className="absolute top-0 flex h-full items-center justify-center gap-1 overflow-hidden border-r border-line-soft text-[10px] tabular-nums text-fg-soft"
                    style={{ left: cell.offset * pxPerDay, width: cell.span * pxPerDay }}
                  >
                    <span>{cell.label}</span>
                    {cell.sub && <span className="text-fg-dim">{cell.sub}</span>}
                  </div>
                ))}
              </div>
            </div>

            <div ref={rowsRef} className="relative" style={{ height: rowsHeight }}>
              {scale === 'day' &&
                Array.from({ length: layout.days }, (_, index) => {
                  const date = addDays(layout.start, index);
                  if (!isWeekend(date)) return null;
                  return (
                    <div
                      key={`weekend-${index}`}
                      className="absolute top-0 bg-overlay-subtle"
                      style={{ left: index * pxPerDay, width: pxPerDay, height: rowsHeight }}
                    />
                  );
                })}
              {todayInAxis && (
                <div
                  className="pointer-events-none absolute top-0 bg-danger/[.06]"
                  style={{
                    left: todayOffset * pxPerDay,
                    width: Math.max(2, scale === 'day' ? pxPerDay : 2),
                    height: rowsHeight,
                  }}
                />
              )}
              {cells.minor.map((cell) => (
                <div
                  key={`grid-${cell.offset}`}
                  className="pointer-events-none absolute top-0 w-px bg-overlay"
                  style={{ left: cell.offset * pxPerDay, height: rowsHeight }}
                />
              ))}

              {creating && (
                <div
                  className="pointer-events-none absolute top-0 rounded-sm border border-info/70 bg-info/[.18]"
                  style={{
                    left: daysBetween(layout.start, creating.from) * pxPerDay,
                    width: (daysBetween(creating.from, creating.to) + 1) * pxPerDay,
                    height: rowsHeight,
                  }}
                >
                  <span className="absolute -top-0.5 left-1 whitespace-nowrap text-[10px] text-info">
                    {shortDate(creating.from)}
                    {creating.from === creating.to ? '' : ` – ${shortDate(creating.to)}`}
                    {` · ${spanDays(creating.from, creating.to)} 天`}
                  </span>
                </div>
              )}

              {(() => {
                let top = 0;
                return layout.rows.map((row) => {
                  const height = rowHeight(row.lanes);
                  const rowTop = top;
                  top += height;
                  return (
                    <Row
                      key={row.color}
                      row={row}
                      height={height}
                      top={rowTop}
                      pxPerDay={pxPerDay}
                      preview={dragPreview}
                      onBarDown={startDrag}
                      onBarMove={moveDrag}
                      onBarUp={endDrag}
                      onBarCancel={cancelDrag}
                      onRowDown={startCreate}
                      onRowMove={moveCreate}
                      onRowUp={endCreate}
                      onRowCancel={cancelCreate}
                    />
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {dialog && (
        <TaskDialog
          key={dialog.seq}
          task={dialogTask}
          draft={dialog.draft ?? null}
          onSave={saveTask}
          onDelete={deleteTask}
          onClose={() => setDialog(null)}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importJson(file);
        }}
      />

      {toast && (
        <div
          className={`pointer-events-none fixed bottom-5 left-1/2 z-[9700] -translate-x-1/2 rounded-md border px-3 py-1.5 text-[11px] shadow-lg ${
            toast.tone === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-panel text-fg-strong'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

/**
 * 一行：同一颜色的任务条。
 *
 * 行自己就是「空白处」：按在行上＝框选新建，按在条上＝拖动改期（条会 stopPropagation）。
 */
function Row({
  row,
  height,
  top,
  pxPerDay,
  preview,
  onBarDown,
  onBarMove,
  onBarUp,
  onBarCancel,
  onRowDown,
  onRowMove,
  onRowUp,
  onRowCancel,
}) {
  return (
    <div
      className="absolute inset-x-0 border-b border-line-soft"
      style={{ height, top, touchAction: 'pan-y' }}
      onPointerDown={onRowDown}
      onPointerMove={onRowMove}
      onPointerUp={onRowUp}
      onPointerCancel={onRowCancel}
    >
      {row.bars.map((bar) => (
        <Bar
          key={bar.id}
          bar={bar}
          pxPerDay={pxPerDay}
          preview={preview?.taskId === bar.taskId ? preview : null}
          onPointerDown={(event) => onBarDown(event, bar)}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarCancel}
        />
      ))}
    </div>
  );
}

function Bar({ bar, pxPerDay, preview, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }) {
  // 拖动中用预览的几何，所以条跟着指针走；松手才写数据
  const left = (preview?.offset ?? bar.offset) * pxPerDay;
  const width = Math.max(6, (preview?.span ?? bar.span) * pxPerDay - 2);
  const top = ROW_PADDING + bar.lane * (BAR_HEIGHT + LANE_GAP);
  // 「10.28」这种写法比一整串 ISO 日期好读，窄条上也放得下
  const start = preview?.start ?? bar.start;
  const end = preview?.end ?? bar.end;
  const range = start === end ? shortDate(start) : `${shortDate(start)}–${shortDate(end)}`;
  return (
    <button
      type="button"
      data-task-bar="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title={`${bar.label}｜${start} → ${end}（${spanDays(start, end)} 天）｜${describeWhen(start, end)}`}
      className={`group/bar absolute flex cursor-grab items-center overflow-hidden rounded-md border text-left text-[11px] shadow-sm transition-[filter] hover:brightness-110 ${
        width >= 52 ? 'px-2' : 'px-1'
      } ${COLOR_META[bar.color].bar}`}
      // pan-y：手机上竖着还能滚，横着才是拖条
      style={{ left, width, top, height: BAR_HEIGHT, touchAction: 'pan-y' }}
    >
      {/* 两端的改期手柄：只做视觉与光标提示，判定还是按按下位置（见 startDrag） */}
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md group-hover/bar:bg-overlay-heavy" />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md group-hover/bar:bg-overlay-heavy" />
      {width >= 22 && (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate font-medium">{bar.label}</span>
          {width >= 120 && <span className="shrink-0 tabular-nums opacity-60">{range}</span>}
        </span>
      )}
    </button>
  );
}
