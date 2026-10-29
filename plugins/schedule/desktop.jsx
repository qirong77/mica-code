import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Crosshair, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  addDays,
  axisCells,
  buildGantt,
  clampZoom,
  isWeekend,
  pxPerDayOf,
  STAGE_ROW_HEIGHT,
  todayScrollLeft,
  zoomAnchor,
  ZOOM_STEP,
} from './gantt';
import { daysBetween, STAGE_LABELS } from './parse';
import { emptySnapshot, normalizeSnapshot } from './snapshot';
import { dayLabel, freshness, shortDate, todayOf } from './view';

/**
 * 排期页：把群公告里的阶段画成一条甘特时间轴。
 *
 * 为什么是整页而不是侧栏卡片：时间轴要的是宽度（几十天）与高度（每群一行），320px 的
 * 浮层里只能退化成列表。交互按「看排期」这件事组织——横向是日历、纵向是项目、条是阶段，
 * 一眼能看出谁和谁撞在同一天。
 *
 * 数据只读：排期的来源是群公告，页面上改不了也不该改（下次整理会被覆盖）。要更新就点
 * 右上角刷新，它转给插件后端去重新抓群公告。
 */

const LABEL_WIDTH = 190;
const DAY_HEADER_HEIGHT = 24;
const MAJOR_HEADER_HEIGHT = 20;

/** 阶段配色：同一天里不同阶段的条不靠文字也能分开。 */
const STAGE_TONE = {
  review: 'border-slate-400/45 bg-slate-400/20 text-slate-100',
  dev: 'border-sky-400/50 bg-sky-500/25 text-sky-50',
  integration: 'border-violet-400/50 bg-violet-500/25 text-violet-50',
  submit: 'border-indigo-400/50 bg-indigo-500/25 text-indigo-50',
  'case-review': 'border-fuchsia-400/45 bg-fuchsia-500/20 text-fuchsia-50',
  testing: 'border-amber-400/50 bg-amber-500/25 text-amber-50',
  acceptance: 'border-teal-400/50 bg-teal-500/25 text-teal-50',
  walkthrough: 'border-lime-400/45 bg-lime-500/20 text-lime-50',
  release: 'border-rose-400/55 bg-rose-500/30 text-rose-50',
  showcase: 'border-cyan-400/50 bg-cyan-500/25 text-cyan-50',
};

const FALLBACK_TONE = 'border-white/25 bg-white/10 text-white/85';

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
  const [selected, setSelected] = useState(null);
  const scrollRef = useRef(null);
  const scrollTopRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  // 缩放只影响像素密度，不该把视野拉回今天；effect 里读这份最新值而不是进依赖
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const load = useCallback(async () => {
    try {
      const result = await api.readData();
      setSnapshot(normalizeSnapshot(result?.value));
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // 后台每 10 分钟按设置判断是否要重新整理；页面开着时顺手跟一次，免得看到隔夜数据。
  useEffect(() => {
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    if (busy) return;
    if (typeof api.action !== 'function') {
      setError('这个版本的宿主还不能从页面触发刷新，请到配置页的插件设置里点「重新整理排期」');
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api.action('refresh');
      if (result?.ok === false) setError(result.error || '整理失败');
      else setMessage(result?.message || '已整理');
      await load();
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      setBusy(false);
    }
  };

  const today = todayOf();
  const groups = useMemo(
    () => snapshot.groups.filter((group) => !group.stages.every((stage) => hidden.has(stage.key))),
    [snapshot, hidden],
  );
  const layout = useMemo(() => buildGantt(groups, { today }), [groups, today]);
  const pxPerDay = pxPerDayOf(scale, zoom);
  const width = Math.max(320, Math.round(layout.days * pxPerDay));
  const cells = useMemo(() => axisCells(layout.start, layout.days, scale), [layout.start, layout.days, scale]);
  const rowsHeight = layout.height;
  const todayOffset = daysBetween(layout.start, today);
  const todayInAxis = todayOffset >= 0 && todayOffset < layout.days;
  const groupOf = useCallback((groupId) => snapshot.groups.find((group) => group.id === groupId), [snapshot]);

  // 换刻度 / 换了数据才回到今天；缩放不走这里（锚点由 changeZoom 自己保持）。
  const scrollToToday = useCallback(() => {
    const host = scrollRef.current;
    if (!host) return;
    host.scrollTo({ left: todayScrollLeft(layout.start, today, pxPerDay, host.clientWidth), behavior: 'smooth' });
  }, [layout.start, today, pxPerDay]);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host || layout.days <= 0) return;
    host.scrollLeft = todayScrollLeft(layout.start, today, pxPerDayOf(scale, zoomRef.current), host.clientWidth);
  }, [scale, layout.start, layout.days, today]);

  // ⌘/Ctrl + 滚轮缩放（锚在光标），Shift + 滚轮横向平移。普通滚轮留给纵向滚动——
  // 群多的时候纵向才是主要动作，缩放有工具栏按钮。
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = clampZoom(zoom * (event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
      if (next === zoom) return;
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
  }, [zoom, layout.start, pxPerDay, scale]);

  const changeZoom = (factor) => {
    const host = scrollRef.current;
    const next = clampZoom(zoom * factor);
    if (next === zoom) return;
    if (host) {
      const anchored = zoomAnchor({
        start: layout.start,
        scrollLeft: host.scrollLeft,
        pxPerDay,
        scale,
        zoom: next,
        anchorX: null,
        viewportWidth: host.clientWidth,
      });
      setZoom(next);
      requestAnimationFrame(() => {
        host.scrollLeft = anchored.scrollLeft;
      });
      return;
    }
    setZoom(next);
  };

  const toggleStage = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays size={14} className="shrink-0 text-white/45" />
          <span className="min-w-0 truncate text-[11px] text-white/40">
            {snapshot.coverage || '还没有整理过'}
            {snapshot.updatedAt ? ` · ${freshness(snapshot.updatedAtMs)}` : ''}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md border border-line bg-white/[.03] p-0.5">
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
                  scale === key ? 'bg-white/[.12] text-white' : 'text-white/50 hover:text-white/85'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center rounded-md border border-line bg-white/[.03] p-0.5">
            <button
              type="button"
              title="缩小（⌘/Ctrl + 滚轮也行）"
              aria-label="缩小"
              disabled={zoom <= 0.5}
              onClick={() => changeZoom(1 / ZOOM_STEP)}
              className="grid h-6 w-6 place-items-center rounded-sm text-white/50 hover:bg-white/[.06] hover:text-white disabled:text-white/20 disabled:hover:bg-transparent"
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              title="恢复默认缩放"
              onClick={() => setZoom(1)}
              className="h-6 w-9 text-[10px] tabular-nums text-white/50 hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              title="放大（⌘/Ctrl + 滚轮也行）"
              aria-label="放大"
              disabled={zoom >= 3}
              onClick={() => changeZoom(ZOOM_STEP)}
              className="grid h-6 w-6 place-items-center rounded-sm text-white/50 hover:bg-white/[.06] hover:text-white disabled:text-white/20 disabled:hover:bg-transparent"
            >
              <ZoomIn size={12} />
            </button>
          </div>

          <button
            type="button"
            title="回到今天"
            onClick={scrollToToday}
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-white/[.03] px-2 text-[11px] text-white/60 hover:border-white/25 hover:text-white"
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
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-white/[.03] px-2 text-[11px] text-white/60 hover:border-white/25 hover:text-white disabled:text-white/25"
          >
            <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
            {busy ? '整理中' : '刷新'}
          </button>
        </div>
      </div>

      {/* 图例兼筛选：点一下把这个阶段的条收起来，用来对比某两条线 */}
      {snapshot.groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          {stageKeysOf(snapshot.groups).map((key) => (
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
              <span className={`size-1.5 rounded-full ${hidden.has(key) ? 'bg-white/40' : 'bg-current'}`} />
              {STAGE_LABELS[key]}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-xs text-white/40">正在读取排期…</div>
      ) : layout.rows.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <div className="max-w-sm text-center text-xs leading-5 text-white/45">
            {snapshot.updatedAtMs
              ? '最近一次整理的窗口里没有群公告写着排期。'
              : '还没整理过。点右上角「刷新」，从 D-Chat 群公告里读一遍排期。'}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左侧固定的项目列：横向滚动时不跟着走 */}
          <div className="flex shrink-0 flex-col border-r border-line bg-panel/40" style={{ width: LABEL_WIDTH }}>
            <div className="shrink-0 border-b border-line" style={{ height: MAJOR_HEADER_HEIGHT + DAY_HEADER_HEIGHT }} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <div className="relative" style={{ height: layout.height, transform: `translateY(${-scrollTop}px)` }}>
                {layout.rows.map((row) =>
                  row.kind === 'group' ? (
                    <div
                      key={row.id}
                      className="absolute inset-x-0 flex flex-col justify-center border-b border-white/[.08] bg-white/[.03] px-2.5"
                      style={{ top: row.top, height: row.height }}
                    >
                      <span className="truncate text-[12px] text-white/85" title={row.name}>
                        {row.name}
                      </span>
                      <span
                        className="truncate text-[10px] text-white/30"
                        title={`公告：${row.author} ${row.announcedAt ? new Date(row.announcedAt).toLocaleString('zh-CN', { hour12: false }) : ''}`}
                      >
                        {row.author || '公告'}
                        {row.announcedAt ? ` · ${shortDate(new Date(row.announcedAt).toISOString().slice(0, 10))}` : ''}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={row.id}
                      className={`absolute inset-x-0 flex items-center gap-1 border-b border-white/[.04] pl-4 pr-2 ${
                        hidden.has(row.key) ? 'opacity-35' : ''
                      }`}
                      style={{ top: row.top, height: row.height }}
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px] text-white/60">{row.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-white/30">
                        {shortDate(row.start)}
                        {row.start === row.end ? '' : `–${shortDate(row.end)}`}
                      </span>
                    </div>
                  ),
                )}
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
                setScrollTop(next);
              }
            }}
          >
            <div style={{ width }}>
              <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur">
                <div className="relative border-b border-white/10" style={{ height: MAJOR_HEADER_HEIGHT }}>
                  {cells.major.map((cell) => (
                    <div
                      key={`major-${cell.offset}`}
                      className="absolute top-0 flex h-full items-center overflow-hidden border-r border-white/10 px-1.5 text-[10px] text-white/45"
                      style={{ left: cell.offset * pxPerDay, width: cell.span * pxPerDay }}
                    >
                      {cell.label}
                    </div>
                  ))}
                  {todayInAxis && (
                    <span
                      className="absolute top-0 flex h-full items-center text-[10px] font-medium text-sky-300"
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
                      className="absolute top-0 flex h-full items-center justify-center gap-1 overflow-hidden border-r border-white/[.07] text-[10px] tabular-nums text-white/55"
                      style={{ left: cell.offset * pxPerDay, width: cell.span * pxPerDay }}
                    >
                      <span>{cell.label}</span>
                      {cell.sub && <span className="text-white/30">{cell.sub}</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="relative" style={{ height: rowsHeight }}>
                {/* 背景：周末底色 + 今天的竖列 + 网格线，都在条下面一层 */}
                {scale === 'day' &&
                  Array.from({ length: layout.days }, (_, index) => {
                    const date = addDays(layout.start, index);
                    if (!isWeekend(date)) return null;
                    return (
                      <div
                        key={`weekend-${index}`}
                        className="absolute top-0 bg-white/[.035]"
                        style={{ left: index * pxPerDay, width: pxPerDay, height: rowsHeight }}
                      />
                    );
                  })}
                {todayInAxis && (
                  <div
                    className="pointer-events-none absolute top-0 bg-sky-400/[.06]"
                    style={{
                      left: todayOffset * pxPerDay,
                      width: Math.max(1, scale === 'day' ? pxPerDay : 2),
                      height: rowsHeight,
                    }}
                  >
                    <div className="h-full w-px bg-sky-400/50" />
                  </div>
                )}
                {cells.minor.map((cell) => (
                  <div
                    key={`grid-${cell.offset}`}
                    className="absolute top-0 w-px bg-white/[.05]"
                    style={{ left: cell.offset * pxPerDay, height: rowsHeight }}
                  />
                ))}

                {layout.rows.map((row) =>
                  row.kind === 'group' ? (
                    <div
                      key={row.id}
                      className="absolute inset-x-0 border-b border-white/[.08] bg-white/[.03]"
                      style={{ top: row.top, height: row.height }}
                    />
                  ) : (
                    <div
                      key={row.id}
                      className="absolute inset-x-0 border-b border-white/[.04]"
                      style={{ top: row.top, height: row.height }}
                    >
                      {!hidden.has(row.key) && (
                        <StageBar
                          row={row}
                          pxPerDay={pxPerDay}
                          active={selected?.stage.id === row.id}
                          onClick={() => setSelected({ stage: row })}
                        />
                      )}
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 选中的阶段：固定条不遮挡时间轴，也不做浮层（浮层一多时间轴就没法看了） */}
      {selected && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel/60 px-3 py-2 text-[11px]">
          <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] ${toneOf(selected.stage.key)}`}>
            {selected.stage.label}
          </span>
          <span className="min-w-0 truncate text-white/85">{groupOf(selected.stage.groupId)?.name ?? ''}</span>
          <span className="shrink-0 tabular-nums text-white/55">
            {shortDate(selected.stage.start)}
            {selected.stage.start === selected.stage.end ? '' : ` – ${shortDate(selected.stage.end)}`}
            <span className="ml-1 text-white/35">共 {selected.stage.span} 天</span>
          </span>
          <span className="min-w-0 truncate text-white/35">
            {groupOf(selected.stage.groupId)?.author ? `公告 ${groupOf(selected.stage.groupId).author}` : '来自群公告'}
            {groupOf(selected.stage.groupId)?.announcedAt
              ? ` · ${new Date(groupOf(selected.stage.groupId).announcedAt).toLocaleString('zh-CN', { hour12: false })}`
              : ''}
          </span>
          <span className="ml-auto shrink-0 text-white/35">
            {dayLabel(selected.stage.start)} 开始
          </span>
          <button
            type="button"
            title="取消选中"
            aria-label="取消选中"
            className="grid size-5 shrink-0 place-items-center rounded-sm text-white/40 hover:bg-white/[.06] hover:text-white"
            onClick={() => setSelected(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {(message || error) && (
        <div className="flex shrink-0 items-center border-t border-line px-3 py-1.5 text-[11px]">
          {error ? <span className="min-w-0 truncate text-rose-300">{error}</span> : <span className="min-w-0 truncate text-emerald-300/80">{message}</span>}
        </div>
      )}
    </div>
  );
}

/** 一个阶段一根条。名称已经写在左侧那一列，条里只在够宽时补一遍日期。 */
function StageBar({ row, pxPerDay, active, onClick }) {
  const left = row.offset * pxPerDay;
  const width = Math.max(6, row.span * pxPerDay - 2);
  // 「10.28」这种写法比一整串 ISO 日期好读，窄条上也放得下
  const range = row.start === row.end ? shortDate(row.start) : `${shortDate(row.start)}–${shortDate(row.end)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.label}｜${range}｜${row.span} 天`}
      className={`absolute flex items-center overflow-hidden rounded-sm border px-1.5 text-left text-[11px] transition-[filter] hover:brightness-125 ${toneOf(row.key)} ${
        active ? 'ring-1 ring-white/70' : ''
      }`}
      style={{ left, width, top: 4, height: STAGE_ROW_HEIGHT - 8 }}
    >
      {/* 太窄的条放字只会剩下「联..」，日期留给左侧那一列与点击后的详情条 */}
      {width >= 64 && <span className="min-w-0 flex-1 truncate text-[10px] opacity-80">{range}</span>}
    </button>
  );
}
