import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, Crosshair, Pencil, Plus, Trash2, X } from 'lucide-react';
import { addDays, daysBetween, todayOf } from './dates';
import {
  axisCells,
  buildGantt,
  clampZoom,
  isWeekend,
  pxPerDayOf,
  todayScrollLeft,
  zoomAnchor,
  ZOOM_STEP,
} from './gantt';
import { applyOperation, emptyData, newId, normalizeData, stamp, STAGE_NAMES } from './schedule';
import { dayLabel, describeWhen, freshness, shortDate, spanDays } from './view';
import { createScheduleWriter } from './writer';

/**
 * 排期页：一行一个计划，行里的彩色条是它的阶段。
 *
 * 为什么是整页而不是侧栏卡片：时间轴要的是宽度（几十天）与高度（每计划一行），320px 的
 * 浮层里只能退化成列表。交互按「看排期」这件事组织——横向是日历、纵向是计划、条是阶段，
 * 一眼能看出谁和谁撞在同一天。
 *
 * 数据只有一层：`data.json` 里的计划与阶段，没有「公告」这种外部事实来源。页面改它、
 * 模型经 `schedule` 工具改它，走的是同一条写盘链（`writer.ts`）：按 id 改一条、版本对不上
 * 就重读重放。页面自己那份只是乐观显示，15 秒轮询一次把别的写入（模型、另一个窗口）
 * 收进来。
 */

const LABEL_WIDTH = 190;
const BAR_HEIGHT = 24;
const LANE_GAP = 4;
const DAY_HEADER_HEIGHT = 24;
const MAJOR_HEADER_HEIGHT = 20;
/** 滚轮累计多少像素才走一档缩放：鼠标滚一格（约 100px）恰好一档，触控板不会一滑到底。 */
const WHEEL_STEP_PX = 100;
/** 条的左右各多少像素算「拖这一端」：再宽就分不清是平移还是改期了。 */
const EDGE_PX = 8;
/** 空白处按下后至少要挪这么多像素才算框选（否则当一次点击，只用来取消选中）。 */
const CREATE_MIN_PX = 4;
/** 首屏读数据：宿主的 IPC 可能比页面晚一步就绪，读到空值再重试几次，最长多等 0.75s。 */
const INITIAL_READ_ATTEMPTS = 3;
const INITIAL_READ_DELAY_MS = 250;
/** 别的写入（模型、另一个窗口）多久同步一次。读的是一份小 JSON，代价可以忽略。 */
const POLL_MS = 15_000;

/** 阶段按名字上色：名字自由，配色不该跟着自由。 */
const TONES = [
  { match: /上线|发布|release/i, className: 'border-rose-400/55 bg-rose-500/30 text-fg-max' },
  { match: /验收|accept/i, className: 'border-teal-400/50 bg-teal-500/25 text-fg-max' },
  { match: /测试|test/i, className: 'border-amber-400/50 bg-amber-500/25 text-fg-max' },
  { match: /联调|integration/i, className: 'border-violet-400/50 bg-violet-500/25 text-fg-max' },
  { match: /提测/, className: 'border-indigo-400/50 bg-indigo-500/25 text-fg-max' },
  { match: /开发|dev/i, className: 'border-sky-400/50 bg-sky-500/25 text-fg-max' },
  { match: /走查|walk/i, className: 'border-lime-400/45 bg-lime-500/20 text-fg-max' },
  { match: /评审|review/i, className: 'border-slate-400/45 bg-slate-400/20 text-fg-max' },
  { match: /showcase|演示/i, className: 'border-cyan-400/50 bg-cyan-500/25 text-fg-max' },
];

/** 认不出的名字用一组固定底色，按名字散开——不会全是一个颜色，也不会每次刷新换色。 */
const FALLBACK_TONES = [
  'border-orange-400/45 bg-orange-500/20 text-fg-max',
  'border-emerald-400/45 bg-emerald-500/20 text-fg-max',
  'border-blue-400/45 bg-blue-500/20 text-fg-max',
  'border-purple-400/45 bg-purple-500/20 text-fg-max',
];

function toneOf(name) {
  for (const tone of TONES) if (tone.match.test(name)) return tone.className;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 997;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length];
}

/** 当前数据里出现过的阶段名（图例与筛选都按它来，顺序按最早的开始日）。 */
function stageNamesOf(plans) {
  const first = new Map();
  for (const plan of plans) {
    for (const stage of plan.stages) {
      if (!first.has(stage.name) || stage.start < first.get(stage.name)) first.set(stage.name, stage.start);
    }
  }
  return [...first.entries()].sort((left, right) => left[1].localeCompare(right[1])).map(([name]) => name);
}

function rowHeight(lanes) {
  return lanes * BAR_HEIGHT + (lanes - 1) * LANE_GAP + 12;
}

/** 一次拖动 / 一次方向键之后的起止；两端手柄碰到对面就收成一天，不会跨过去。 */
function dragRange({ mode, baseStart, baseEnd, deltaDays }) {
  if (mode === 'move') {
    return { start: addDays(baseStart, deltaDays), end: addDays(baseEnd, deltaDays) };
  }
  if (mode === 'start') {
    const start = addDays(baseStart, deltaDays);
    return start <= baseEnd ? { start, end: baseEnd } : { start: baseEnd, end: baseEnd };
  }
  const end = addDays(baseEnd, deltaDays);
  return end >= baseStart ? { start: baseStart, end } : { start: baseStart, end: baseStart };
}

function errorText(caught) {
  return caught instanceof Error ? caught.message : String(caught);
}

async function readWithRetry(read) {
  let value = await read();
  for (let attempt = 1; value == null && attempt < INITIAL_READ_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, INITIAL_READ_DELAY_MS));
    value = await read();
  }
  return value;
}

export default function SchedulePage({ api }) {
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [scale, setScale] = useState('day');
  const [zoom, setZoom] = useState(1);
  const [hidden, setHidden] = useState(() => new Set());
  /** 选中的是「哪条阶段」，不是某个坐标：拖动后 bar.id 变了也还选着它 */
  const [selected, setSelected] = useState(null);
  /** 拖动中的预览：`{ planId, stageId, start, end }`，松手前不改数据 */
  const [drag, setDrag] = useState(null);
  /** 空白处框选的范围（预览） */
  const [creating, setCreating] = useState(null);
  /** 框选松手后弹的阶段菜单 */
  const [picker, setPicker] = useState(null);
  /** 计划名编辑：`{ mode: 'create' }` 或 `{ mode: 'rename', planId }` */
  const [planEdit, setPlanEdit] = useState(null);
  const [planDraft, setPlanDraft] = useState('');
  /** 待确认删除的计划（删除不可撤销，问一句） */
  const [confirmPlan, setConfirmPlan] = useState(null);

  const scrollRef = useRef(null);
  const rowsRef = useRef(null);
  const labelsRef = useRef(null);
  const scrollTopRef = useRef(0);
  // 缩放只影响像素密度，不该把视野拉回今天；effect 里读这份最新值而不是进依赖
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // 只认最后一次读的结果：轮询那一轮还在跑时用户点了什么，旧值不该盖掉新状态
  const readSeqRef = useRef(0);
  // 事件回调里要读最新一份数据：拖完一条要基于「现在这份」再算
  const dataRef = useRef(data);
  const dragRef = useRef(null);
  const createRef = useRef(null);
  const suppressClickRef = useRef(false);
  /** 方向键连按时上一格的结果：state 还没重渲染，不能拿旧条算下一次 */
  const nudgeRef = useRef(null);
  const flashTimerRef = useRef(0);
  /** Esc 取消重命名：先置位再 blur，否则 blur 的提交会把刚取消的名字写回去 */
  const skipPlanCommitRef = useRef(false);
  const writerRef = useRef(null);

  if (!writerRef.current) {
    writerRef.current = createScheduleWriter({
      host: api,
      onError: (text) => setError(text),
    });
  }
  const writer = writerRef.current;

  const flash = useCallback((text) => {
    setMessage(text);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setMessage(''), 2000);
  }, []);

  const load = useCallback(
    async ({ retryIfEmpty = false } = {}) => {
      if (writer.pending() > 0) return;
      const seq = ++readSeqRef.current;
      const read = async () => {
        const result = await api.readData();
        if (result?.ok === false) throw new Error(result.error || '读取排期失败');
        return result?.value ?? null;
      };
      try {
        const value = retryIfEmpty ? await readWithRetry(read) : await read();
        if (seq !== readSeqRef.current || writer.pending() > 0) return;
        const next = normalizeData(value);
        dataRef.current = next;
        setData(next);
        setError('');
      } catch (caught) {
        if (seq !== readSeqRef.current) return;
        setError(errorText(caught));
      } finally {
        if (seq === readSeqRef.current) setLoading(false);
      }
      nudgeRef.current = null;
    },
    [api, writer],
  );

  useEffect(() => {
    void load({ retryIfEmpty: true });
  }, [load]);

  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  // 别处的改动（模型、另一个窗口）跟着轮询进来；正在拖 / 正在存的时候不刷新，
  // 读到的新数据会把指针底下那条换掉，手一松就对不上了
  useEffect(() => {
    const timer = setInterval(() => {
      if (dragRef.current || createRef.current || picker || planEdit || confirmPlan) return;
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, picker, planEdit, confirmPlan]);

  const commit = useCallback(
    (operation, note) => {
      let next;
      try {
        next = stamp(applyOperation(dataRef.current, operation));
      } catch (caught) {
        setError(errorText(caught));
        return false;
      }
      dataRef.current = next;
      setData(next);
      setError('');
      writer.push(operation);
      void writer.flush().then((ok) => {
        if (ok) flash(note);
        else void load();
      });
      return true;
    },
    [flash, load, writer],
  );

  const today = todayOf();
  const plans = data.plans;
  const layout = useMemo(() => buildGantt(plans, { today }), [plans, today]);
  const pxPerDay = pxPerDayOf(scale, zoom);
  const width = Math.max(320, Math.round(layout.days * pxPerDay));
  const cells = useMemo(() => axisCells(layout.start, layout.days, scale), [layout.start, layout.days, scale]);
  const rowsHeight = layout.rows.reduce((sum, row) => sum + rowHeight(row.lanes), 0);
  const hasTimeline = !loading && layout.rows.length > 0;
  const todayOffset = daysBetween(layout.start, today);
  const todayInAxis = todayOffset >= 0 && todayOffset < layout.days;
  const stageNames = useMemo(() => stageNamesOf(plans), [plans]);

  const selectedBar = useMemo(() => {
    if (!selected) return null;
    for (const row of layout.rows) {
      const bar = row.bars.find((item) => item.stageId === selected.stageId);
      if (bar) return { bar, row };
    }
    return null;
  }, [layout, selected]);

  /** 拖动中的预览换算成几何（偏移与天数），Row 只按它画 */
  const dragPreview = useMemo(() => {
    if (!drag) return null;
    return {
      stageId: drag.stageId,
      start: drag.start,
      end: drag.end,
      offset: daysBetween(layout.start, drag.start),
      span: daysBetween(drag.start, drag.end) + 1,
    };
  }, [drag, layout.start]);

  const scrollToToday = useCallback(() => {
    const host = scrollRef.current;
    if (!host) return;
    host.scrollTo({ left: todayScrollLeft(layout.start, today, pxPerDay, host.clientWidth), behavior: 'smooth' });
  }, [layout.start, today, pxPerDay]);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host || layout.days <= 0) return;
    host.scrollLeft = todayScrollLeft(layout.start, today, pxPerDayOf(scale, zoomRef.current), host.clientWidth);
  }, [hasTimeline, scale, layout.start, layout.days, today]);

  // 滚轮就是缩放（锚在光标）：上下滚一档一档来，Shift 或触控板横滑才平移。
  // 滚轮既然给了缩放，纵向滚动交给滚动条——一次滚动只改一样，手感才不会两件事一起动。
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return undefined;
    let acc = 0;
    const onWheel = (event) => {
      event.preventDefault();
      // deltaMode：0=像素 1=行 2=页，统一折成像素再累计，免得鼠标滚一格跳好几档
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        acc = 0;
        host.scrollLeft += Math.abs(dx) > Math.abs(dy) ? dx : dy;
        return;
      }
      if (dy * acc < 0) acc = 0;
      acc += dy;
      const steps = Math.trunc(acc / WHEEL_STEP_PX);
      if (!steps) return;
      acc -= steps * WHEEL_STEP_PX;
      // 向下滚 = 缩小，和地图类应用一致
      const next = clampZoom(zoomRef.current * ZOOM_STEP ** -steps);
      if (next === zoomRef.current) return;
      const anchored = zoomAnchor({
        start: layout.start,
        scrollLeft: host.scrollLeft,
        pxPerDay,
        scale,
        zoom: next,
        anchorX: event.clientX - host.getBoundingClientRect().left,
        viewportWidth: host.clientWidth,
      });
      setZoom(next);
      requestAnimationFrame(() => {
        host.scrollLeft = anchored.scrollLeft;
      });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [hasTimeline, layout.start, pxPerDay, scale]);

  const toggleStage = (name) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /* ------------------------------------------------------------ 计划 */

  const startCreatePlan = () => {
    setPlanEdit({ mode: 'create' });
    setPlanDraft('');
    setConfirmPlan(null);
  };

  const startRenamePlan = (row) => {
    setPlanEdit({ mode: 'rename', planId: row.planId });
    setPlanDraft(row.name);
    setConfirmPlan(null);
  };

  const submitPlan = () => {
    if (skipPlanCommitRef.current) {
      skipPlanCommitRef.current = false;
      setPlanEdit(null);
      setPlanDraft('');
      return;
    }
    const name = planDraft.trim();
    if (!name) {
      setPlanEdit(null);
      return;
    }
    if (planEdit?.mode === 'create') {
      commit({ type: 'add-plan', plan: { id: newId('p'), name, note: '', stages: [] } }, `已新建「${name}」`);
    } else if (planEdit?.mode === 'rename') {
      commit({ type: 'update-plan', planId: planEdit.planId, name }, '已改名');
    }
    setPlanEdit(null);
    setPlanDraft('');
  };

  const deletePlan = (planId) => {
    setConfirmPlan(null);
    if (selected?.planId === planId) setSelected(null);
    commit({ type: 'delete-plan', planId }, '已删除计划');
  };

  /**
   * 不用拖也能加一条：行右侧的「＋」从今天起给一周，选名字之后在编辑栏里改日期。
   *
   * 拖选是主路径（快、所见即所得），但月视角一天只有几像素、触控板上也不好拉，
   * 总得留一条不依赖精确拖拽的入口。
   */
  const openStagePicker = (row) => {
    setSelected(null);
    setPicker({
      x: Math.max(8, window.innerWidth / 2 - 152),
      y: Math.max(8, window.innerHeight / 3),
      planId: row.planId,
      planName: row.name,
      start: today,
      end: addDays(today, 6),
    });
  };

  /* ------------------------------------------------------------ 拖动 / 新建 */

  /** 按下位置落在条的哪一段：两端各 EDGE_PX 算改期，中间算整条平移。 */
  const dragModeAt = (event, rect) => {
    const left = event.clientX - rect.left;
    const right = rect.right - event.clientX;
    const edge = Math.min(EDGE_PX, Math.max(2, rect.width / 3));
    if (left <= edge) return 'start';
    if (right <= edge) return 'end';
    return 'move';
  };

  /**
   * 位移上限：让预览始终落在当前时间轴里，拖到看不见的地方就没法判断了。
   * 轴两端本来各留了几天空白，所以贴边松手后轴会按新数据重新撑开，还能接着往外拖。
   */
  const clampDelta = (delta, active) => {
    const lowest = -daysBetween(layout.start, active.baseStart);
    if (active.mode === 'move') return Math.max(lowest, Math.min(delta, daysBetween(active.baseEnd, layout.end)));
    if (active.mode === 'start') {
      return Math.max(lowest, Math.min(delta, daysBetween(active.baseStart, active.baseEnd)));
    }
    return Math.max(
      -daysBetween(active.baseStart, active.baseEnd),
      Math.min(delta, daysBetween(active.baseEnd, layout.end)),
    );
  };

  const startDrag = (event, row, bar) => {
    if (event.button !== 0) return;
    // 条自己处理按下：否则会落到行上，变成「空白处框选」
    event.stopPropagation();
    // 上一次拖动留下的「吃掉下一个 click」只能管那一次：真没收到 click（指针在外面松手）
    // 时不能在下次点击时把它吞掉
    suppressClickRef.current = false;
    // 拖过了就不再延续方向键那串累积结果
    nudgeRef.current = null;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      row,
      bar,
      mode: dragModeAt(event, rect),
      originX: event.clientX,
      baseStart: bar.start,
      baseEnd: bar.end,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件拿不到指针，不影响后续的 pointermove / pointerup
    }
  };

  const moveDrag = (event) => {
    const active = dragRef.current;
    if (!active) return;
    const deltaPx = event.clientX - active.originX;
    // 手抖几像素不算拖动，否则「点一下」也会被当成拖了一天
    if (!active.moved && Math.abs(deltaPx) < 3) return;
    active.moved = true;
    const delta = clampDelta(Math.round(deltaPx / pxPerDay), active);
    const next = dragRange({
      mode: active.mode,
      baseStart: active.baseStart,
      baseEnd: active.baseEnd,
      deltaDays: delta,
    });
    active.start = next.start;
    active.end = next.end;
    setDrag({ planId: active.row.planId, stageId: active.bar.stageId, ...next });
  };

  const endDrag = () => {
    const active = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    // 没挪动就是一次点击，选中交给 onClick；挪过了则要吃掉随后那个 click
    if (!active?.moved) return;
    suppressClickRef.current = true;
    const start = active.start ?? active.baseStart;
    const end = active.end ?? active.baseEnd;
    if (start === active.baseStart && end === active.baseEnd) return;
    commit({ type: 'update-stage', stageId: active.bar.stageId, start, end }, '已保存');
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const dayAtClientX = (clientX) => {
    const host = rowsRef.current;
    if (!host) return null;
    const index = Math.floor((clientX - host.getBoundingClientRect().left) / pxPerDay);
    if (index < 0 || index >= layout.days) return null;
    return addDays(layout.start, index);
  };

  const startCreate = (event, row) => {
    if (event.button !== 0) return;
    suppressClickRef.current = false;
    const date = dayAtClientX(event.clientX);
    if (!date) return;
    createRef.current = { row, anchor: date, originX: event.clientX, moved: false, from: date, to: date };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 同上：拿不到指针也能走完 pointermove / pointerup
    }
    // 空白处按下就是「取消选中」——一次点击只表达一件事
    setSelected(null);
    setCreating({ planId: row.planId, from: date, to: date });
  };

  const moveCreate = (event) => {
    const active = createRef.current;
    if (!active) return;
    if (!active.moved && Math.abs(event.clientX - active.originX) < CREATE_MIN_PX) return;
    active.moved = true;
    const date = dayAtClientX(event.clientX);
    if (!date) return;
    const from = active.anchor < date ? active.anchor : date;
    const to = active.anchor < date ? date : active.anchor;
    active.from = from;
    active.to = to;
    setCreating({ planId: active.row.planId, from, to });
  };

  const endCreate = (event) => {
    const active = createRef.current;
    createRef.current = null;
    setCreating(null);
    if (!active?.moved) return;
    setPicker({
      x: event.clientX,
      y: event.clientY,
      planId: active.row.planId,
      planName: active.row.name,
      start: active.from,
      end: active.to,
    });
  };

  const cancelCreate = () => {
    createRef.current = null;
    setCreating(null);
  };

  const addStage = (name) => {
    const target = picker;
    if (!target) return;
    const stage = { id: newId('s'), name, start: target.start, end: target.end };
    setPicker(null);
    if (commit({ type: 'add-stage', planId: target.planId, stage }, `已加「${name}」`)) {
      setSelected({ planId: target.planId, stageId: stage.id });
    }
  };

  const deleteStage = (bar) => {
    nudgeRef.current = null;
    if (commit({ type: 'delete-stage', stageId: bar.stageId }, '已删除')) setSelected(null);
  };

  // 选中之后的方向键：拖不准的时候（月视角一天只有几像素）靠它一天一天挪
  useEffect(() => {
    if (!picker && !selectedBar && !planEdit) return undefined;
    const onKey = (event) => {
      const target = event.target;
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === 'Escape') {
        if (picker) setPicker(null);
        else if (planEdit) setPlanEdit(null);
        else setSelected(null);
        return;
      }
      if (typing || !selectedBar || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      // ⌘/Ctrl + 方向键留给系统（切桌面、浏览器前进后退），这里只认裸键与 Shift/Alt
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const mode = event.shiftKey ? 'end' : event.altKey ? 'start' : 'move';
      const identity = selectedBar.bar.stageId;
      // 按住不放时 keydown 每秒来几十次，拿还没重渲染的旧条算会吃掉其中几格
      const base = nudgeRef.current?.identity === identity ? nudgeRef.current : null;
      const next = dragRange({
        mode,
        baseStart: base?.start ?? selectedBar.bar.start,
        baseEnd: base?.end ?? selectedBar.bar.end,
        deltaDays: event.key === 'ArrowLeft' ? -1 : 1,
      });
      nudgeRef.current = { identity, start: next.start, end: next.end };
      commit({ type: 'update-stage', stageId: identity, start: next.start, end: next.end }, '已保存');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedBar, picker, planEdit, commit]);

  const hasPlans = plans.length > 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays size={14} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 truncate text-[11px] text-fg-muted">
            {data.summary || '还没有计划'}
            {data.updatedAt ? ` · ${freshness(data.updatedAtMs)}` : ''}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md border border-line bg-overlay-subtle p-0.5">
            {[
              ['day', '日'],
              ['week', '周'],
              ['month', '月'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setScale(key)}
                aria-pressed={scale === key}
                className={`h-6 w-7 rounded-sm text-[11px] transition-colors ${
                  scale === key ? 'bg-overlay-heavy text-fg-max' : 'text-fg-muted hover:text-fg-strong'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="text-[10px] tabular-nums text-fg-dim" title="滚轮缩放，Shift + 滚轮平移">
            {Math.round(zoom * 100)}%
          </span>

          <button
            type="button"
            title="回到今天"
            onClick={scrollToToday}
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-overlay-subtle px-2 text-[11px] text-fg-soft hover:border-line-strong hover:text-fg-max"
          >
            <Crosshair size={11} />
            今天
          </button>

          <button
            type="button"
            title="新建一个计划（一行）"
            onClick={startCreatePlan}
            className="flex h-6 items-center gap-1 rounded-md border border-line-strong bg-overlay-subtle px-2 text-[11px] text-fg-strong hover:text-fg-max"
          >
            <Plus size={11} />
            新建计划
          </button>
        </div>

        {planEdit && (
          <form
            className="absolute right-3 top-11 z-30 flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1.5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              submitPlan();
            }}
          >
            <span className="shrink-0 text-[10px] text-fg-muted">{planEdit.mode === 'create' ? '新计划' : '改名'}</span>
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={planDraft}
              onChange={(event) => setPlanDraft(event.target.value)}
              placeholder="项目或主题的名字"
              maxLength={40}
              className="h-6 w-48 rounded-sm border border-line bg-canvas px-1.5 text-[11px] text-fg-strong outline-none focus:border-line-strong"
            />
            <button
              type="submit"
              title="保存"
              aria-label="保存"
              className="grid size-6 place-items-center rounded-sm border border-line text-fg-soft hover:text-fg-max"
            >
              <Check size={11} />
            </button>
            <button
              type="button"
              title="取消"
              aria-label="取消"
              onClick={() => setPlanEdit(null)}
              className="grid size-6 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
            >
              <X size={11} />
            </button>
          </form>
        )}
      </div>

      {/* 图例兼筛选：点一下把这个阶段的条收起来，用来对比某两条线 */}
      {stageNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          {stageNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => toggleStage(name)}
              aria-pressed={!hidden.has(name)}
              title={hidden.has(name) ? `显示「${name}」` : `隐藏「${name}」`}
              className={`flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] transition-opacity ${
                hidden.has(name) ? 'border-line text-fg-muted opacity-35' : toneOf(name)
              }`}
            >
              <span className={`size-1.5 rounded-full ${hidden.has(name) ? 'bg-fg-muted' : 'bg-current'}`} />
              {name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-xs text-fg-muted">正在读取排期…</div>
      ) : !hasPlans ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <div className="max-w-md text-center text-xs leading-5 text-fg-muted">
            <p className="mb-2 text-[13px] text-fg-strong">排期还是空的</p>
            <p>点右上角「新建计划」加一行，然后在这一行里横拖出时间条（也可以点行右侧的 ＋ 直接加一条）。</p>
            <p className="mt-1">
              也可以直接跟模型说一句，比如「下周一开发、两周后上线，帮我排进 X 项目」——它会用
              <span className="mx-1 rounded-sm bg-overlay px-1 text-[11px] text-fg-soft">schedule</span>
              技能改这份排期。
            </p>
            <button
              type="button"
              onClick={startCreatePlan}
              className="mt-3 inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-overlay-subtle px-3 text-[11px] text-fg-strong hover:text-fg-max"
            >
              <Plus size={12} />
              新建计划
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左侧固定的计划列：横向滚动时不跟着走 */}
          <div className="flex shrink-0 flex-col border-r border-line bg-panel/40" style={{ width: LABEL_WIDTH }}>
            <div
              className="shrink-0 border-b border-line"
              style={{ height: MAJOR_HEADER_HEIGHT + DAY_HEADER_HEIGHT }}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <div ref={labelsRef} style={{ transform: `translateY(${-scrollTopRef.current}px)` }}>
                {layout.rows.map((row) => (
                  <div
                    key={row.planId}
                    className="group/row flex items-center gap-1 border-b border-line-soft px-2.5"
                    style={{ height: rowHeight(row.lanes) }}
                  >
                    {planEdit?.mode === 'rename' && planEdit.planId === row.planId ? (
                      <input
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={planDraft}
                        onChange={(event) => setPlanDraft(event.target.value)}
                        onBlur={submitPlan}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitPlan();
                          if (event.key === 'Escape') {
                            skipPlanCommitRef.current = true;
                            event.currentTarget.blur();
                          }
                        }}
                        maxLength={40}
                        className="h-6 w-full rounded-sm border border-line bg-canvas px-1.5 text-[12px] text-fg-strong outline-none focus:border-line-strong"
                      />
                    ) : confirmPlan === row.planId ? (
                      <div className="flex w-full items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-[10px] text-danger">删除这个计划？</span>
                        <button
                          type="button"
                          title="确认删除"
                          aria-label="确认删除"
                          onClick={() => deletePlan(row.planId)}
                          className="grid size-5 shrink-0 place-items-center rounded-sm text-danger hover:bg-overlay"
                        >
                          <Check size={11} />
                        </button>
                        <button
                          type="button"
                          title="取消"
                          aria-label="取消"
                          onClick={() => setConfirmPlan(null)}
                          className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] text-fg-strong" title={row.name}>
                            {row.name}
                          </div>
                          <div className="truncate text-[10px] text-fg-dim" title={row.note}>
                            {row.note || (row.bars.length > 0 ? `${row.bars.length} 条阶段` : '还没有阶段')}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                          <button
                            type="button"
                            title="给这个计划加一条阶段"
                            aria-label="给这个计划加一条阶段"
                            onClick={() => openStagePicker(row)}
                            className="grid size-5 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
                          >
                            <Plus size={10} />
                          </button>
                          <button
                            type="button"
                            title="重命名计划"
                            aria-label="重命名计划"
                            onClick={() => startRenamePlan(row)}
                            className="grid size-5 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
                          >
                            <Pencil size={10} />
                          </button>
                          <button
                            type="button"
                            title="删除计划"
                            aria-label="删除计划"
                            onClick={() => setConfirmPlan(row.planId)}
                            className="grid size-5 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-danger"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) => {
              const next = event.currentTarget.scrollTop;
              if (next !== scrollTopRef.current) {
                scrollTopRef.current = next;
                if (labelsRef.current) labelsRef.current.style.transform = `translateY(${-next}px)`;
              }
            }}
          >
            {/* 缩小到比视口还窄时也撑满：否则行分隔线到内容右边界就断掉，看着像画到一半 */}
            <div style={{ width, minWidth: '100%' }}>
              <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur">
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
                <div className="relative border-b border-line" style={{ height: DAY_HEADER_HEIGHT }}>
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
                {/* 背景：周末底色 + 今天的竖列 + 网格线，都在条下面一层 */}
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
                    className="pointer-events-none absolute top-0 bg-info/[.06]"
                    style={{
                      left: todayOffset * pxPerDay,
                      width: Math.max(1, scale === 'day' ? pxPerDay : 2),
                      height: rowsHeight,
                    }}
                  >
                    <div className="h-full w-px bg-info/50" />
                  </div>
                )}
                {cells.minor.map((cell) => (
                  <div
                    key={`grid-${cell.offset}`}
                    className="absolute top-0 w-px bg-overlay"
                    style={{ left: cell.offset * pxPerDay, height: rowsHeight }}
                  />
                ))}

                {/* 空白处框选：铺满所有行的半透明块，松手后弹阶段菜单 */}
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
                        key={row.planId}
                        row={row}
                        height={height}
                        top={rowTop}
                        pxPerDay={pxPerDay}
                        hidden={hidden}
                        selected={selected}
                        preview={dragPreview}
                        onSelect={(bar) => {
                          // 刚拖完松手时浏览器会补一个 click，别把它当成「选中」
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                          }
                          setSelected({ planId: row.planId, stageId: bar.stageId });
                        }}
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
        </div>
      )}

      {/* 选中的阶段：固定条不遮挡时间轴，也不做浮层（浮层一多时间轴就没法看了） */}
      {selectedBar && (
        <StageEditor
          bar={selectedBar.bar}
          planName={selectedBar.row.name}
          onChange={(patch) => commit({ type: 'update-stage', stageId: selectedBar.bar.stageId, ...patch }, '已保存')}
          onDelete={() => deleteStage(selectedBar.bar)}
          onClose={() => setSelected(null)}
        />
      )}

      {/* 框选松手后的阶段菜单：选一个名字（或自己写一个），这条就加到那个计划里 */}
      {picker && (
        <StagePicker
          picker={picker}
          onPick={addStage}
          onRange={(range) => setPicker((prev) => (prev ? { ...prev, ...range } : prev))}
          onCancel={() => setPicker(null)}
        />
      )}

      {(message || error) && (
        <div className="flex shrink-0 items-center border-t border-line px-3 py-1.5 text-[11px]">
          {error ? (
            <span className="min-w-0 truncate text-danger">{error}</span>
          ) : (
            <span className="min-w-0 truncate text-success-soft">{message}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 选中一条阶段后的编辑条：名称与起止日期都能直接改（拖动在月视角下只有几像素，靠它精修）。
 *
 * 名称用本地输入、失焦或回车才写盘：每敲一个字发一条操作会把写盘链塞满，也没有必要。
 */
function StageEditor({ bar, planName, onChange, onDelete, onClose }) {
  const [name, setName] = useState(bar.label);
  /** Esc 放弃这次改名：先置位再 blur，免得上一次输入被 onBlur 提交上去 */
  const cancelNameRef = useRef(false);

  useEffect(() => {
    setName(bar.label);
  }, [bar.stageId, bar.label]);

  const commitName = () => {
    if (cancelNameRef.current) {
      cancelNameRef.current = false;
      setName(bar.label);
      return;
    }
    const next = name.trim();
    if (!next || next === bar.label) return;
    onChange({ name: next });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line bg-panel/60 px-3 py-2 text-[11px]">
      <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] ${toneOf(bar.label)}`}>{bar.label}</span>
      <span className="min-w-0 max-w-[180px] truncate text-fg-strong" title={planName}>
        {planName}
      </span>
      <label className="flex shrink-0 items-center gap-1 text-[10px] text-fg-dim">
        名称
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              cancelNameRef.current = true;
              event.currentTarget.blur();
            }
          }}
          maxLength={40}
          className="h-6 w-28 rounded-sm border border-line bg-canvas px-1.5 text-[11px] text-fg-strong outline-none focus:border-line-strong"
        />
      </label>
      <label className="flex shrink-0 items-center gap-1 text-[10px] text-fg-dim">
        起
        <input
          type="date"
          value={bar.start}
          onChange={(event) => {
            const start = event.target.value;
            if (!start) return;
            onChange({ start, end: bar.end < start ? start : bar.end });
          }}
          className="h-6 rounded-sm border border-line bg-canvas px-1 text-[11px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
        />
      </label>
      <label className="flex shrink-0 items-center gap-1 text-[10px] text-fg-dim">
        止
        <input
          type="date"
          value={bar.end}
          onChange={(event) => {
            const end = event.target.value;
            if (!end) return;
            onChange({ start: bar.start > end ? end : bar.start, end });
          }}
          className="h-6 rounded-sm border border-line bg-canvas px-1 text-[11px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
        />
      </label>
      <span className="shrink-0 tabular-nums text-fg-soft">
        共 {spanDays(bar.start, bar.end)} 天 · {dayLabel(bar.start)} 开始
      </span>
      <span className="shrink-0 text-fg-dim">{describeWhen(bar.start, bar.end)}</span>
      <span className="ml-auto shrink-0 text-[10px] text-fg-dim">
        拖条体平移，拖两端改起止；← → 挪一天，Shift + ← → 改结束，Alt + ← → 改开始
      </span>
      <button
        type="button"
        title="删掉这条阶段"
        className="flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 text-[10px] text-fg-soft hover:border-line-strong hover:text-danger"
        onClick={onDelete}
      >
        <Trash2 size={10} />
        删除
      </button>
      <button
        type="button"
        title="取消选中"
        aria-label="取消选中"
        className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * 框选松手后的名字菜单：常用阶段点一下就走，也可以自己写一个。
 *
 * 用的是「名字」而不是「类型」：阶段本来就是用户自己的说法，页面按名字猜颜色，
 * 不需要先教用户一套分类。
 */
function StagePicker({ picker, onPick, onRange, onCancel }) {
  const [custom, setCustom] = useState('');
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onCancel} aria-hidden="true" />
      <div
        className="fixed z-20 w-72 rounded-md border border-line bg-panel p-2 shadow-2xl"
        style={{
          left: Math.max(8, Math.min(picker.x, window.innerWidth - 296)),
          top: Math.max(8, Math.min(picker.y, window.innerHeight - 300)),
        }}
      >
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="shrink-0 text-[10px] text-fg-muted">加一条阶段</span>
          <span className="min-w-0 truncate text-[10px] tabular-nums text-fg-soft">
            {`${spanDays(picker.start, picker.end)} 天`}
          </span>
        </div>
        <div className="mb-1.5 min-w-0 truncate text-[10px] text-fg-dim" title={picker.planName}>
          {picker.planName}
        </div>
        <div className="mb-1.5 flex items-center gap-1">
          <input
            type="date"
            value={picker.start}
            onChange={(event) => {
              const start = event.target.value;
              if (start) onRange({ start, end: picker.end < start ? start : picker.end });
            }}
            className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-[10px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
          />
          <span className="shrink-0 text-[10px] text-fg-dim">→</span>
          <input
            type="date"
            value={picker.end}
            onChange={(event) => {
              const end = event.target.value;
              if (end) onRange({ start: picker.start > end ? end : picker.start, end });
            }}
            className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 text-[10px] tabular-nums text-fg-strong outline-none focus:border-line-strong"
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          {STAGE_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onPick(name)}
              className={`flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] ${toneOf(name)}`}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-current" />
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-1.5 flex items-center gap-1 border-t border-line-soft pt-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const name = custom.trim();
            if (name) onPick(name);
          }}
        >
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="自己写一个名字"
            maxLength={40}
            className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 text-[11px] text-fg-strong outline-none focus:border-line-strong"
          />
          <button
            type="submit"
            title="加这一条"
            className="grid size-6 shrink-0 place-items-center rounded-sm border border-line text-fg-soft hover:text-fg-max"
          >
            <Plus size={11} />
          </button>
        </form>
      </div>
    </>
  );
}

/**
 * 一行：这个计划的阶段条。
 *
 * 行自己就是「空白处」：按在行上＝框选新建，按在条上＝拖动改期（条会 stopPropagation）。
 */
function Row({
  row,
  height,
  top,
  pxPerDay,
  hidden,
  selected,
  preview,
  onSelect,
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
      style={{ height, top }}
      onPointerDown={(event) => onRowDown(event, row)}
      onPointerMove={onRowMove}
      onPointerUp={onRowUp}
      onPointerCancel={onRowCancel}
    >
      {row.bars
        .filter((bar) => !hidden.has(bar.label))
        .map((bar) => (
          <Bar
            key={bar.id}
            bar={bar}
            pxPerDay={pxPerDay}
            active={selected?.stageId === bar.stageId}
            preview={preview?.stageId === bar.stageId ? preview : null}
            onClick={() => onSelect(bar)}
            onPointerDown={(event) => onBarDown(event, row, bar)}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={onBarCancel}
          />
        ))}
    </div>
  );
}

function Bar({ bar, pxPerDay, active, preview, onClick, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }) {
  // 拖动中用预览的几何，所以条跟着指针走；松手才写数据
  const left = (preview?.offset ?? bar.offset) * pxPerDay;
  const width = Math.max(6, (preview?.span ?? bar.span) * pxPerDay - 2);
  const top = 6 + bar.lane * (BAR_HEIGHT + LANE_GAP);
  // 「10.28」这种写法比一整串 ISO 日期好读，窄条上也放得下
  const start = preview?.start ?? bar.start;
  const end = preview?.end ?? bar.end;
  const range = start === end ? shortDate(start) : `${shortDate(start)}–${shortDate(end)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title={`${bar.label}｜${start} → ${end}（${spanDays(start, end)} 天）｜${describeWhen(start, end)}`}
      className={`group/bar absolute flex cursor-grab items-center overflow-hidden rounded-sm border px-1.5 text-left text-[11px] transition-[filter] hover:brightness-125 ${toneOf(
        bar.label,
      )} ${active ? 'ring-1 ring-fg-max/70' : ''}`}
      // pan-y：手机上竖着还能滚，横着才是拖条
      style={{ left, width, top, height: BAR_HEIGHT, touchAction: 'pan-y' }}
    >
      {/* 两端的改期手柄：只做视觉与光标提示，判定还是按按下位置（见 dragModeAt） */}
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-sm group-hover/bar:bg-overlay-heavy" />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-sm group-hover/bar:bg-overlay-heavy" />
      {width >= 46 && (
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="truncate">{bar.label}</span>
          {width >= 110 && <span className="shrink-0 tabular-nums opacity-60">{range}</span>}
        </span>
      )}
    </button>
  );
}
