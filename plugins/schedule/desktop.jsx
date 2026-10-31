import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Crosshair, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { applyEdits, dragRange, dropEdit, mergeEditChanges, newStageId, pruneEdits, upsertEdit } from './edits';
import {
  addDays,
  axisCells,
  buildGantt,
  clampZoom,
  isWeekend,
  pxPerDayOf,
  todayScrollLeft,
  zoomAnchor,
  ZOOM_STEP,
} from './gantt';
import { daysBetween, STAGE_LABELS } from './parse';
import { emptySnapshot, normalizeSnapshot, readWithRetry, SCHEDULE_VERSION } from './snapshot';
import { dayLabel, freshness, shortDate, todayOf } from './view';

/**
 * 排期页：把群公告里的阶段画成一条甘特时间轴。
 *
 * 为什么是整页而不是侧栏卡片：时间轴要的是宽度（几十天）与高度（每群一行），320px 的
 * 浮层里只能退化成列表。交互按「看排期」这件事组织——横向是日历、纵向是项目、条是阶段，
 * 一眼能看出谁和谁撞在同一天。
 *
 * 数据是「群公告解析结果 + 本地修订」两层：公告那层只读，用户拖动的结果存成修订
 * （`edits`，见 edits.ts），下一轮整理照旧保留——公告本身不动，所以别人看到的还是原样。
 * 要拿最新公告就点右上角刷新，它转给插件后端重新抓一遍。
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
/**
 * 首屏读数据的重试：宿主的 IPC 可能比页面晚一步就绪，一次读到空不该直接画「还没有整理过」
 * ——那会让人以为没数据。只在首屏且读到空值时重试，最多多等 0.75s。
 */
const INITIAL_READ_ATTEMPTS = 3;
const INITIAL_READ_DELAY_MS = 250;

/** 阶段配色：同一天里不同阶段的条不靠文字也能分开。 */
const STAGE_TONE = {
  review: 'border-slate-400/45 bg-slate-400/20 text-fg-max',
  dev: 'border-sky-400/50 bg-sky-500/25 text-fg-max',
  integration: 'border-violet-400/50 bg-violet-500/25 text-fg-max',
  submit: 'border-indigo-400/50 bg-indigo-500/25 text-fg-max',
  'case-review': 'border-fuchsia-400/45 bg-fuchsia-500/20 text-fg-max',
  testing: 'border-amber-400/50 bg-amber-500/25 text-fg-max',
  acceptance: 'border-teal-400/50 bg-teal-500/25 text-fg-max',
  walkthrough: 'border-lime-400/45 bg-lime-500/20 text-fg-max',
  release: 'border-rose-400/55 bg-rose-500/30 text-fg-max',
  showcase: 'border-cyan-400/50 bg-cyan-500/25 text-fg-max',
};

const FALLBACK_TONE = 'border-line-strong bg-overlay-strong text-fg-strong';

function toneOf(key) {
  return STAGE_TONE[key] ?? FALLBACK_TONE;
}

/** 收集当前数据里出现过的阶段（图例与筛选都按它来，顺序沿用公告里的规范顺序）。 */
function stageKeysOf(groups) {
  const seen = new Set();
  for (const group of groups) for (const stage of group.stages) seen.add(stage.key);
  return Object.keys(STAGE_LABELS).filter((key) => seen.has(key));
}

export default function SchedulePage({ api }) {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [scale, setScale] = useState('day');
  const [zoom, setZoom] = useState(1);
  const [hidden, setHidden] = useState(() => new Set());
  /** 选中的是「哪条阶段」，不是某个坐标：拖动后 id 变了也还选着它 */
  const [selected, setSelected] = useState(null);
  /** 拖动中的预览：`{ groupId, stageId, mode, start, end }`，松手前不改数据 */
  const [drag, setDrag] = useState(null);
  /** 空白处框选的范围（预览） */
  const [creating, setCreating] = useState(null);
  /** 框选松手后弹的阶段菜单（自己选一个阶段建条） */
  const [picker, setPicker] = useState(null);
  const scrollRef = useRef(null);
  const rowsRef = useRef(null);
  const labelsRef = useRef(null);
  const scrollTopRef = useRef(0);
  // 缩放只影响像素密度，不该把视野拉回今天；effect 里读这份最新值而不是进依赖
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // 只认最后一次读的结果：首屏那一轮还在重试时用户点了刷新，旧值不该盖掉新的
  const readSeqRef = useRef(0);
  // 事件回调里要读最新一份数据：拖完一条要基于「现在的修订」再追加，不能拿渲染时那份闭包
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const dragRef = useRef(null);
  const createRef = useRef(null);
  const suppressClickRef = useRef(false);
  /** 方向键连按时上一格的结果：state 还没重渲染，不能拿旧条算下一次 */
  const nudgeRef = useRef(null);
  /** 修订列表的权威副本（比 state 早一步），写盘也排在这条链上 */
  const editsRef = useRef([]);
  const savedEditsRef = useRef([]);
  const writeChainRef = useRef(Promise.resolve());
  const pendingWritesRef = useRef(0);
  const editVersionRef = useRef(0);
  const saveNoteRef = useRef('');
  const refreshBusyRef = useRef(false);
  const flashTimerRef = useRef(0);

  const load = useCallback(
    async ({ retryIfEmpty = false } = {}) => {
      if (pendingWritesRef.current > 0) return;
      const seq = ++readSeqRef.current;
      const read = async () => {
        const result = await api.readData();
        if (result?.ok === false) throw new Error(result.error || '读取排期失败');
        return result?.value ?? null;
      };
      try {
        const value = retryIfEmpty
          ? await readWithRetry(read, {
              attempts: INITIAL_READ_ATTEMPTS,
              delayMs: INITIAL_READ_DELAY_MS,
            })
          : await read();
        if (seq !== readSeqRef.current) return;
        const next = normalizeSnapshot(value);
        editsRef.current = next.edits;
        savedEditsRef.current = next.edits;
        setSnapshot(next);
      } catch (caught) {
        if (seq !== readSeqRef.current) return;
        setError(caught?.message || String(caught));
      } finally {
        if (seq === readSeqRef.current) setLoading(false);
      }
      nudgeRef.current = null;
    },
    [api],
  );

  useEffect(() => {
    void load({ retryIfEmpty: true });
  }, [load]);

  // 后台每 10 分钟按设置判断是否要重新整理；页面开着时顺手跟一次，免得看到隔夜数据。
  useEffect(() => {
    const timer = setInterval(() => {
      // 正在拖动时不刷新：读到的新数据会把指针底下那条换掉，手一松就对不上了
      if (dragRef.current || createRef.current) return;
      void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  const flash = useCallback((text) => {
    setMessage(text);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setMessage(''), 2000);
  }, []);

  /**
   * 存一次修订。
   *
   * 写盘前重新读一次，而不是把手里这份整份盖回去：整理（几十秒）可能刚好在这期间跑完，
   * 拿旧快照盖回去等于把刚抓到的公告丢了。修订按「群 + 阶段身份」定位，盖到最新那份上
   * 是对的；读不到数据（文件被清空）才退回内存里这份。
   */
  const writeEdits = useCallback(async () => {
    // 修订列表以 ref 为准：state 要等下一次渲染，连着改两条时后者会看不到前者
    try {
      if (typeof api.writeData !== 'function') throw new Error('这个版本的宿主还不能保存改动，请更新桌面端');
      const current = snapshotRef.current;
      const edits = editsRef.current;
      const previous = savedEditsRef.current;
      let merged;
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await api.readData();
        if (result?.ok === false) throw new Error(result.error || '读取排期失败');
        const base = result?.value == null ? current : normalizeSnapshot(result.value);
        merged = {
          ...base,
          version: SCHEDULE_VERSION,
          edits: pruneEdits(base.groups, mergeEditChanges(base.edits, previous, edits), current.groups),
        };
        const version = result?.version;
        const options = typeof version === 'string' || version === null ? { expectedVersion: version } : undefined;
        const saved = await api.writeData(merged, options);
        if (saved?.ok !== false) break;
        if (!saved.conflict) throw new Error(saved.error || '保存排期失败');
        if (attempt === 7) throw new Error('排期正在其他窗口更新，请稍后重试');
      }
      savedEditsRef.current = merged.edits;
      // 写盘时下一次按键可能已经改了 ref；只收敛本次仍然是最新的那份，避免吃掉后来的改动。
      editsRef.current = mergeEditChanges(merged.edits, edits, editsRef.current);
      const next = { ...merged, edits: editsRef.current };
      snapshotRef.current = next;
      setSnapshot(next);
      setError('');
      return true;
    } catch (caught) {
      setError(caught?.message || String(caught));
      return false;
    }
  }, [api]);

  /** 写盘串成一条链：连按方向键时两次写不能各读到对方之前的那份，否则后一次覆盖前一次。 */
  const saveEdits = useCallback(
    (edits, note) => {
      readSeqRef.current += 1;
      editVersionRef.current += 1;
      saveNoteRef.current = note;
      editsRef.current = edits;
      const next = { ...snapshotRef.current, edits };
      snapshotRef.current = next;
      setSnapshot(next);
      setError('');
      if (pendingWritesRef.current > 0) return writeChainRef.current;
      pendingWritesRef.current = 1;
      const run = writeChainRef.current.then(async () => {
        let saved;
        for (;;) {
          const version = editVersionRef.current;
          saved = await writeEdits();
          if (version === editVersionRef.current) break;
        }
        pendingWritesRef.current = 0;
        if (saved) flash(saveNoteRef.current);
        else await load();
      });
      writeChainRef.current = run.catch(() => {});
      return run;
    },
    [writeEdits, load, flash],
  );

  const commitEdit = useCallback((edit) => saveEdits(upsertEdit(editsRef.current, edit), '已保存'), [saveEdits]);

  const refresh = async () => {
    if (refreshBusyRef.current) return;
    if (typeof api.action !== 'function') {
      setError('这个版本的宿主还不能从页面触发刷新，请到配置页的插件设置里点「重新整理排期」');
      return;
    }
    refreshBusyRef.current = true;
    readSeqRef.current += 1;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api.action('refresh');
      if (result?.ok === false) setError(result.error || result.message || '整理失败');
      else setMessage(result?.message || '已整理');
      await writeChainRef.current;
      await load();
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      refreshBusyRef.current = false;
      setBusy(false);
    }
  };

  const today = todayOf();
  // 公告那份只读，拖动结果在 `snapshot.edits` 里；这里把两层合成界面要画的那份
  const editedGroups = useMemo(() => applyEdits(snapshot.groups, snapshot.edits), [snapshot]);
  const groups = useMemo(
    () => editedGroups.filter((group) => !group.stages.every((stage) => hidden.has(stage.key))),
    [editedGroups, hidden],
  );
  const layout = useMemo(() => buildGantt(groups, { today }), [groups, today]);
  const pxPerDay = pxPerDayOf(scale, zoom);
  const width = Math.max(320, Math.round(layout.days * pxPerDay));
  const cells = useMemo(() => axisCells(layout.start, layout.days, scale), [layout.start, layout.days, scale]);
  const rowsHeight = layout.rows.reduce((sum, row) => sum + rowHeight(row.lanes), 0);
  const hasTimeline = !loading && layout.rows.length > 0;
  const todayOffset = daysBetween(layout.start, today);
  const todayInAxis = todayOffset >= 0 && todayOffset < layout.days;

  // 选中态按身份找当前那条（拖动后 `bar.id` 会变，身份不变）
  const selectedBar = useMemo(() => {
    if (!selected) return null;
    for (const row of layout.rows) {
      const bar = row.bars.find((item) => item.groupId === selected.groupId && item.stageId === selected.stageId);
      if (bar) return { bar, row };
    }
    return null;
  }, [layout, selected]);

  /** 拖动中的预览换算成几何（偏移与天数），Row 只按它画 */
  const dragPreview = useMemo(() => {
    if (!drag) return null;
    return {
      groupId: drag.groupId,
      stageId: drag.stageId,
      start: drag.start,
      end: drag.end,
      offset: daysBetween(layout.start, drag.start),
      span: daysBetween(drag.start, drag.end) + 1,
    };
  }, [drag, layout.start]);

  // 换刻度 / 换了数据才回到今天；缩放不走这里（锚点由滚轮自己保持）。
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

  const toggleStage = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
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
    setDrag({ groupId: active.row.groupId, stageId: active.bar.stageId, mode: active.mode, ...next });
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
    void commitEdit({
      id: active.bar.stageId,
      groupId: active.row.groupId,
      key: active.bar.key,
      added: active.bar.added,
      start,
      end,
      at: Date.now(),
    });
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
    setCreating({ groupId: row.groupId, from: date, to: date });
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
    setCreating({ groupId: active.row.groupId, from, to });
  };

  const endCreate = (event) => {
    const active = createRef.current;
    createRef.current = null;
    setCreating(null);
    if (!active?.moved) return;
    setPicker({
      x: event.clientX,
      y: event.clientY,
      groupId: active.row.groupId,
      name: active.row.name,
      start: active.from,
      end: active.to,
    });
  };

  const cancelCreate = () => {
    createRef.current = null;
    setCreating(null);
  };

  const addStage = (key) => {
    const target = picker;
    if (!target) return;
    const at = Date.now();
    const id = newStageId(key, at);
    setPicker(null);
    setSelected({ groupId: target.groupId, stageId: id });
    void commitEdit({ id, groupId: target.groupId, key, added: true, start: target.start, end: target.end, at });
  };

  /** 只删掉本地的这条修订：改过的是还原公告值，自己新建的是整条删掉。 */
  const dropSelectedEdit = () => {
    if (!selectedBar) return;
    nudgeRef.current = null;
    const { bar } = selectedBar;
    void saveEdits(dropEdit(editsRef.current, bar.groupId, bar.stageId), bar.added ? '已删除' : '已还原为公告值');
  };

  // 选中之后的方向键：拖不准的时候（月视角一天只有几像素）靠它一天一天挪
  useEffect(() => {
    if (!picker && !selectedBar) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (picker) setPicker(null);
        else setSelected(null);
        return;
      }
      if (!selectedBar || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // ⌘/Ctrl + 方向键留给系统（切桌面、浏览器前进后退），这里只认裸键与 Shift/Alt
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const mode = event.shiftKey ? 'end' : event.altKey ? 'start' : 'move';
      const identity = `${selectedBar.bar.groupId}:${selectedBar.bar.stageId}`;
      // 按住不放时 keydown 每秒来几十次，拿还没重渲染的旧条算会吃掉其中几格
      const base = nudgeRef.current?.identity === identity ? nudgeRef.current : null;
      const next = dragRange({
        mode,
        baseStart: base?.start ?? selectedBar.bar.start,
        baseEnd: base?.end ?? selectedBar.bar.end,
        deltaDays: event.key === 'ArrowLeft' ? -1 : 1,
      });
      nudgeRef.current = { identity, start: next.start, end: next.end };
      void commitEdit({
        id: selectedBar.bar.stageId,
        groupId: selectedBar.bar.groupId,
        key: selectedBar.bar.key,
        added: selectedBar.bar.added,
        start: next.start,
        end: next.end,
        at: Date.now(),
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedBar, picker, commitEdit]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays size={14} className="shrink-0 text-fg-muted" />
          <span
            className="min-w-0 truncate text-[11px] text-fg-muted"
            title={snapshot.errors.map((entry) => `${entry.name}：${entry.message}`).join('\n')}
          >
            {snapshot.coverage || '还没有整理过'}
            {snapshot.scope.partial ? ' · 没扫全（未更新的群保留上次结果）' : ''}
            {snapshot.errors.length > 0 ? ` · ${snapshot.errors.length} 个群没扫成` : ''}
            {snapshot.updatedAt ? ` · ${freshness(snapshot.updatedAtMs)}` : ''}
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
            title="重新整理排期（读一遍群公告）"
            aria-label="重新整理排期"
            disabled={busy}
            onClick={() => void refresh()}
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-overlay-subtle px-2 text-[11px] text-fg-soft hover:border-line-strong hover:text-fg-max disabled:text-fg-ghost"
          >
            <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
            {busy ? '整理中' : '刷新'}
          </button>
        </div>
      </div>

      {/* 图例兼筛选：点一下把这个阶段的条收起来，用来对比某两条线 */}
      {snapshot.groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          {stageKeysOf(editedGroups).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleStage(key)}
              aria-pressed={!hidden.has(key)}
              title={hidden.has(key) ? `显示「${STAGE_LABELS[key]}」` : `隐藏「${STAGE_LABELS[key]}」`}
              className={`flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] transition-opacity ${
                hidden.has(key) ? 'border-line opacity-35' : toneOf(key)
              }`}
            >
              <span className={`size-1.5 rounded-full ${hidden.has(key) ? 'bg-fg-muted' : 'bg-current'}`} />
              {STAGE_LABELS[key]}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-xs text-fg-muted">正在读取排期…</div>
      ) : layout.rows.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <div className="max-w-sm text-center text-xs leading-5 text-fg-muted">
            {snapshot.updatedAtMs
              ? '最近一次整理的窗口里没有群公告写着排期。'
              : '还没整理过。点右上角「刷新」，从 D-Chat 群公告里读一遍排期。'}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左侧固定的项目列：横向滚动时不跟着走 */}
          <div className="flex shrink-0 flex-col border-r border-line bg-panel/40" style={{ width: LABEL_WIDTH }}>
            <div
              className="shrink-0 border-b border-line"
              style={{ height: MAJOR_HEADER_HEIGHT + DAY_HEADER_HEIGHT }}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <div ref={labelsRef} style={{ transform: `translateY(${-scrollTopRef.current}px)` }}>
                {layout.rows.map((row) => (
                  <div
                    key={row.groupId}
                    className="flex flex-col justify-center border-b border-line-soft px-2.5"
                    style={{ height: rowHeight(row.lanes) }}
                  >
                    <span className="truncate text-[12px] text-fg-strong" title={row.name}>
                      {row.name}
                    </span>
                    <span
                      className="truncate text-[10px] text-fg-dim"
                      title={`公告：${row.author} ${row.announcedAt ? new Date(row.announcedAt).toLocaleString('zh-CN', { hour12: false }) : ''}`}
                    >
                      {row.author || '公告'}
                      {row.announcedAt ? ` · ${shortDate(new Date(row.announcedAt).toISOString().slice(0, 10))}` : ''}
                    </span>
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
                      {` · ${daysBetween(creating.from, creating.to) + 1} 天`}
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
                        key={row.groupId}
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
                          setSelected({ groupId: row.groupId, stageId: bar.stageId });
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
        <div className="flex shrink-0 flex-col gap-1 border-t border-line bg-panel/60 px-3 py-2 text-[11px]">
          <div className="flex items-center gap-3">
            <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] ${toneOf(selectedBar.bar.key)}`}>
              {selectedBar.bar.label}
            </span>
            <span className="min-w-0 truncate text-fg-strong">{selectedBar.row.name}</span>
            <span className="shrink-0 tabular-nums text-fg-soft">
              {shortDate(selectedBar.bar.start)}
              {selectedBar.bar.start === selectedBar.bar.end ? '' : ` – ${shortDate(selectedBar.bar.end)}`}
              <span className="ml-1 text-fg-dim">共 {selectedBar.bar.span} 天</span>
            </span>
            {selectedBar.bar.edited && (
              <span className="shrink-0 rounded-sm bg-overlay px-1 py-0.5 text-[10px] text-warn-soft">
                {selectedBar.bar.added ? '本地新增' : '手动调整过'}
              </span>
            )}
            {selectedBar.bar.edited && selectedBar.bar.originalStart && (
              <span className="shrink-0 tabular-nums text-fg-dim">
                公告原值 {shortDate(selectedBar.bar.originalStart)}
                {selectedBar.bar.originalStart === selectedBar.bar.originalEnd
                  ? ''
                  : `–${shortDate(selectedBar.bar.originalEnd)}`}
              </span>
            )}
            <span className="ml-auto shrink-0 text-fg-dim">{dayLabel(selectedBar.bar.start)} 开始</span>
            {selectedBar.bar.edited && (
              <button
                type="button"
                title={selectedBar.bar.added ? '删掉这条本地新增' : '还原成公告里的日期'}
                className="flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 text-[10px] text-fg-soft hover:border-line-strong hover:text-fg-max"
                onClick={dropSelectedEdit}
              >
                {selectedBar.bar.added ? <Trash2 size={10} /> : <RotateCcw size={10} />}
                {selectedBar.bar.added ? '删除' : '还原'}
              </button>
            )}
            <button
              type="button"
              title="取消选中"
              aria-label="取消选中"
              className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-overlay hover:text-fg-max"
              onClick={() => setSelected(null)}
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-fg-dim">
            <span className="shrink-0">拖条体平移，拖两端改起止；← → 挪一天，Shift + ← → 改结束，Alt + ← → 改开始</span>
            <span className="min-w-0 truncate">
              {selectedBar.row.author ? `公告 ${selectedBar.row.author}` : '来自群公告'}
              {selectedBar.row.announcedAt
                ? ` · ${new Date(selectedBar.row.announcedAt).toLocaleString('zh-CN', { hour12: false })}`
                : ''}
            </span>
          </div>
        </div>
      )}

      {/* 框选松手后的阶段菜单：先选「这是个什么阶段」，再建条。点外面或 Esc 取消 */}
      {picker && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setPicker(null)} aria-hidden="true" />
          <div
            className="fixed z-20 w-52 rounded-md border border-line bg-panel p-2 shadow-2xl"
            style={{
              left: Math.max(8, Math.min(picker.x, window.innerWidth - 216)),
              top: Math.max(8, Math.min(picker.y, window.innerHeight - 260)),
            }}
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-[10px] text-fg-muted">加一条</span>
              <span className="min-w-0 truncate text-[10px] tabular-nums text-fg-soft">
                {shortDate(picker.start)}
                {picker.start === picker.end ? '' : ` – ${shortDate(picker.end)}`}
              </span>
            </div>
            <div className="mb-1.5 min-w-0 truncate text-[10px] text-fg-dim" title={picker.name}>
              {picker.name}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {Object.entries(STAGE_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => addStage(key)}
                  className={`flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] ${toneOf(key)}`}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-current" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
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

function rowHeight(lanes) {
  return lanes * BAR_HEIGHT + (lanes - 1) * LANE_GAP + 12;
}

/**
 * 一行：这个项目的阶段条。名称在左侧列，条上不放字（窄条只剩「联..」）。
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
        .filter((bar) => !hidden.has(bar.key))
        .map((bar) => (
          <Bar
            key={bar.id}
            bar={bar}
            pxPerDay={pxPerDay}
            active={selected?.groupId === row.groupId && selected?.stageId === bar.stageId}
            preview={preview?.groupId === row.groupId && preview?.stageId === bar.stageId ? preview : null}
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
  const note = bar.added ? '｜本地新增' : bar.edited ? '｜手动调整过' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title={`${bar.label}｜${range}｜${preview?.span ?? bar.span} 天${note}`}
      className={`group/bar absolute flex cursor-grab items-center overflow-hidden rounded-sm border px-1.5 text-left text-[11px] transition-[filter] hover:brightness-125 ${
        bar.edited ? 'border-dashed' : ''
      } ${toneOf(bar.key)} ${active ? 'ring-1 ring-fg-max/70' : ''}`}
      // pan-y：手机上竖着还能滚，横着才是拖条
      style={{ left, width, top, height: BAR_HEIGHT, touchAction: 'pan-y' }}
    >
      {/* 两端的改期手柄：只做视觉与光标提示，判定还是按按下位置（见 dragModeAt） */}
      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-sm group-hover/bar:bg-overlay-heavy" />
      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-sm group-hover/bar:bg-overlay-heavy" />
      {width >= 46 && <span className="min-w-0 flex-1 truncate">{bar.label}</span>}
    </button>
  );
}
