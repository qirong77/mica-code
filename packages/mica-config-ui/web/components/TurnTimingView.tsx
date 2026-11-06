import { useEffect, useMemo, useState } from 'react';
import {
  summarizeTurnTiming,
  type TurnTimingKind,
  type TurnTimingState,
  type TurnTimingSummary,
} from '@packages/mica-common/turnTiming.js';
import { formatElapsed } from '@packages/mica-web-shared/index.js';
import { TIMING_SORT_OPTIONS } from '../labels.js';
import { SelectMenu } from './SelectMenu.js';
import { Segmented } from './Ui.js';

/**
 * 一轮的时间去哪了。
 *
 * 明细默认按发生顺序，也可按耗时从长到短排。上面给三类的合计条、图例与工具耗时排行；
 * 明细每一行按占整轮的份额铺底色，与合计条同一刻度，最长的那段单独标出来。
 *
 * 唯一实现：桌面端的「耗时」弹窗与配置页 / 会话详情的「耗时」页签都渲染这里，前者传的
 * 是磁盘上的记录 + 正在跑的那一轮，后者只有磁盘上的记录。
 */

/** 一轮的来源：磁盘上的一条记录，或桌面端现场推出来的本轮。 */
export type TurnTimingRound = {
  /** 稳定标识（用本轮起点毫秒），下拉里选的就是它。 */
  id: string;
  state: TurnTimingState;
  /** 仍在跑的轮次：只有桌面端当前这轮会是 true。 */
  live?: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  error: '失败',
  aborted: '已中止',
};

const KIND_LABEL: Record<TurnTimingKind, string> = {
  wait: '等待模型',
  generate: '模型输出',
  tool: '工具执行',
};

/** 三类各自的含义；第一眼看到「等待模型 63%」时要知道等的是什么。 */
const KIND_HINT: Record<TurnTimingKind, string> = {
  wait: '请求发出到第一个 token 回来',
  generate: '流式输出正文与思考',
  tool: '工具执行（含结果回填）',
};

/** 工具排行只列前三，其余折成「另有 N 种」，完整清单在悬停提示里。 */
const TOOL_BREAKDOWN_LIMIT = 3;

type TimingSort = 'time' | 'duration';

export function sortTimingItems(timing: TurnTimingSummary, order: TimingSort) {
  const rows = timing.timeline.map((item, index) => ({ item, index }));
  return rows.sort((a, b) => {
    if (order === 'duration') {
      const delta = b.item.durationMs - a.item.durationMs;
      if (delta) return delta;
    }
    return a.item.offsetMs - b.item.offsetMs || a.index - b.index;
  });
}

function statusText(timing: TurnTimingSummary): string {
  if (timing.running) return '进行中';
  return STATUS_LABEL[timing.outcome ?? 'completed'] ?? '已完成';
}

function statusClass(timing: TurnTimingSummary): string {
  if (timing.running) return 'is-running';
  if (timing.outcome === 'error') return 'is-error';
  if (timing.outcome === 'aborted') return 'is-partial';
  return 'is-done';
}

function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function itemLabel(groupId: TurnTimingKind, item: TurnTimingSummary['timeline'][number]): string {
  if (groupId === 'wait') {
    if (item.live) return '等待中';
    if (item.tail) return '收尾（本轮结束前）';
    return '等待首字';
  }
  if (groupId === 'generate') {
    return item.chars > 0 ? `输出 ${item.chars.toLocaleString()} 字符` : '输出';
  }
  return item.displayText || item.tool || '工具调用';
}

function itemStatusLabel(item: TurnTimingSummary['timeline'][number]): string {
  if (item.status === 'completed') return '';
  if (item.status === 'aborted') return '已中止';
  if (item.status === 'error') return '失败';
  if (item.status === 'pending') return '进行中';
  return '';
}

/** 三类的段宽就是各自的合计耗时；段内直接写百分比，窄到放不下就只留 hover。 */
function GroupBar({ timing }: { timing: TurnTimingSummary }) {
  const rows = timing.groups
    .map((group, index) => ({ group, percent: timing.percents[index] ?? 0 }))
    .filter((row) => row.group.totalMs > 0);
  if (!rows.length) return null;
  return (
    <div className="timing-bar" aria-hidden="true">
      {rows.map(({ group, percent }) => (
        <span
          key={group.id}
          className={`timing-bar-seg is-${group.id}`}
          title={`${KIND_LABEL[group.id]} ${formatElapsed(group.totalMs)} · ${percent}%`}
          style={{ flexGrow: group.totalMs }}
        >
          {percent >= 8 ? <span className="timing-bar-pct">{percent}%</span> : null}
        </span>
      ))}
    </div>
  );
}

/** 图例就是答案本身：三类各占多少、发生几次、一共多久。 */
function GroupLegend({ timing }: { timing: TurnTimingSummary }) {
  return (
    <div className="timing-legend">
      {timing.groups.map((group, index) => {
        const empty = group.count === 0;
        return (
          <div key={group.id} className={`timing-legend-item${empty ? ' is-empty' : ''}`} title={KIND_HINT[group.id]}>
            <div className="timing-legend-head">
              <span className={`timing-dot is-${group.id}`} aria-hidden="true" />
              <span className="timing-legend-name">{KIND_LABEL[group.id]}</span>
              <span className="timing-legend-pct">{timing.percents[index] ?? 0}%</span>
            </div>
            <div className="timing-legend-meta">
              {empty ? '没有发生' : `${group.count} 次 · ${formatElapsed(group.totalMs)}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 工具按名字聚合：同一类工具被调了十几次时，顺序列表里看不出它才是大头。 */
function ToolBreakdown({ timing }: { timing: TurnTimingSummary }) {
  const entries = timing.toolBreakdown;
  if (entries.length < 2) return null;
  const shown = entries.slice(0, TOOL_BREAKDOWN_LIMIT);
  const rest = entries.length - shown.length;
  const text = shown.map((entry) => `${entry.tool} ${entry.count} 次 · ${formatElapsed(entry.totalMs)}`).join(' ／ ');
  return (
    <div
      className="timing-tools"
      title={entries.map((entry) => `${entry.tool}：${entry.count} 次 · ${formatElapsed(entry.totalMs)}`).join('\n')}
    >
      工具耗时：{text}
      {rest > 0 ? ` ／ 另有 ${rest} 种` : ''}
    </div>
  );
}

function roundOptions(rounds: TurnTimingRound[]) {
  return rounds.map((round, index) => {
    const timing = summarizeTurnTiming(round.state);
    const facts = [
      `第 ${index + 1} 轮`,
      clockText(round.state.startedAt),
      timing ? formatElapsed(timing.totalMs) : '',
      round.live ? '进行中' : '',
    ].filter(Boolean);
    return { value: round.id, label: facts.join(' · ') };
  });
}

/**
 * 一句话结论：先回答「时间花在哪」，再让人去看数字。
 *
 * 三类里占比最高的那一类就是答案（没有发生的那类不参与）；「最慢的一段」按明细算，
 * 它常常就是用户真正想找的那次慢请求。
 */
function verdictText(timing: TurnTimingSummary): string {
  const ranked = timing.groups
    .map((group, index) => ({ group, percent: timing.percents[index] ?? 0 }))
    .filter((row) => row.group.totalMs > 0)
    .sort((a, b) => b.group.totalMs - a.group.totalMs);
  const [top, second] = ranked;
  if (!top) return '这一轮几乎没有耗时。';
  const head = `主要花在${KIND_LABEL[top.group.id]}（${top.percent}%，${formatElapsed(top.group.totalMs)}）`;
  const secondPart = second ? `，其次是${KIND_LABEL[second.group.id]}（${second.percent}%）` : '';
  const slowest = timing.timeline[timing.slowestIndex];
  const slowestPart =
    slowest && timing.timeline.length > 1
      ? `；最慢的一段是 ${
          slowest.kind === 'tool' ? slowest.displayText || slowest.tool : KIND_LABEL[slowest.kind]
        } ${formatElapsed(slowest.durationMs)}`
      : '';
  return `${head}${secondPart}${slowestPart}。`;
}

export function TurnTimingView({
  rounds,
  emptyLabel = '还没有耗时记录：跑一轮之后这里会显示时间去了哪里。',
  now,
}: {
  rounds: TurnTimingRound[];
  emptyLabel?: string;
  /** 运行中一轮的「此刻」；定时刷新的宿主传进来，静态宿主可以不给。 */
  now?: number;
}) {
  const sorted = useMemo(() => [...rounds].sort((a, b) => a.state.startedAt - b.state.startedAt), [rounds]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<TimingSort>('time');
  const newestId = sorted.length ? sorted[sorted.length - 1]!.id : '';

  // 默认停在最新一轮；选中的那一轮被裁掉（超过保留上限）时同样落回最新一轮，而不是空白。
  useEffect(() => {
    if (!sorted.length) {
      if (selectedId) setSelectedId('');
      return;
    }
    if (!sorted.some((round) => round.id === selectedId)) setSelectedId(newestId);
  }, [newestId, selectedId, sorted]);

  if (!sorted.length) {
    return <div className="timing-empty">{emptyLabel}</div>;
  }

  const selected = sorted.find((round) => round.id === selectedId) ?? sorted[sorted.length - 1]!;
  const timing = summarizeTurnTiming(selected.state, now);
  if (!timing) return <div className="timing-empty">{emptyLabel}</div>;
  const options = roundOptions(sorted);
  const rows = sortTimingItems(timing, sortOrder);
  const byDuration = sortOrder === 'duration';

  return (
    <div className="timing-view">
      <div className="timing-head">
        {sorted.length > 1 ? (
          <div className="timing-picker">
            <span className="timing-picker-label">轮次</span>
            <SelectMenu
              value={selected.id}
              options={options}
              onChange={setSelectedId}
              ariaLabel="选择要查看的轮次"
              menuMinWidth={260}
              size="compact"
            />
          </div>
        ) : (
          <span className="timing-picker-label">第 1 轮 · {clockText(selected.state.startedAt)}</span>
        )}
        <div className="timing-facts">
          <span className={`timing-status ${statusClass(timing)}`}>{statusText(timing)}</span>
          <span>总耗时 {formatElapsed(timing.totalMs)}</span>
          <span>{timing.requests} 次请求</span>
          <span>{timing.toolCalls} 次工具调用</span>
        </div>
      </div>

      <div className="timing-overview">
        <div className="timing-verdict">{verdictText(timing)}</div>
        <GroupBar timing={timing} />
        <GroupLegend timing={timing} />
        <ToolBreakdown timing={timing} />
      </div>

      <div className="timing-sort">
        <Segmented
          value={sortOrder}
          options={TIMING_SORT_OPTIONS}
          onChange={(next) => setSortOrder(next === 'duration' ? 'duration' : 'time')}
          ariaLabel="执行过程排序"
          size="compact"
        />
      </div>
      <div className="timing-columns" aria-hidden="true">
        <span>开始于</span>
        <span>{byDuration ? '执行过程 · 耗时从长到短' : '执行过程 · 按发生顺序'}</span>
        <span>耗时</span>
      </div>
      <ol
        className={`timing-list${byDuration ? ' is-duration' : ''}`}
        aria-label={byDuration ? '按耗时从长到短的执行过程' : '按时间顺序的执行过程'}
      >
        {rows.map(({ item, index }) => {
          const badge = itemStatusLabel(item);
          const detail = itemLabel(item.kind, item);
          const slowest = index === timing.slowestIndex && timing.timeline.length > 1;
          return (
            <li
              className={`timing-item is-${item.kind}${slowest ? ' is-slowest' : ''}`}
              key={index}
              style={{ '--timing-share': `${item.share * 100}%` } as never}
              title={`${KIND_LABEL[item.kind]} · ${formatElapsed(item.durationMs)}（占整轮 ${(item.share * 100).toFixed(
                1,
              )}%）`}
            >
              <span className="timing-offset">+{formatElapsed(item.offsetMs)}</span>
              <span className="timing-marker" aria-hidden="true">
                <span className={`timing-dot is-${item.kind}`} />
              </span>
              <span className="timing-content">
                <span className="timing-name">{KIND_LABEL[item.kind]}</span>
                <span className="timing-item-label" title={detail}>
                  {detail}
                </span>
              </span>
              {slowest ? <span className="timing-badge is-slowest">最慢</span> : null}
              {badge ? <span className={`timing-badge is-${item.status}`}>{badge}</span> : null}
              <span className="timing-ms">{formatElapsed(item.durationMs)}</span>
            </li>
          );
        })}
      </ol>
      <div className="timing-note">
        区间首尾相接，三类合计就是整轮耗时。「等待模型」是请求发出到第一个 token 回来的那段时间，模型慢、
        网关慢、网络慢都在这一段里；调用方的排队与页面渲染不计入。
      </div>
    </div>
  );
}
