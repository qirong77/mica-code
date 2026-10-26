import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { clearPerformanceLogs, readPerformanceDetails } from '../api.js';
import type {
  ConfigWebPerfBucket,
  ConfigWebPerfEvent,
  ConfigWebPerformanceDetails,
  ConfigWebPerfTimelinePoint,
} from '../../src/shared/types.js';

/**
 * Performance：本机性能与诊断面板。
 *
 * 数据全部来自运行时自己写的 JSONL（`host/log.js`，落在系统 temp，开机自动清空）：
 * - 渲染层每秒一个采样点：事件循环延迟（lag）、长任务（long/longN）、DOM 规模、堆大小；
 * - 每个 host 通道的调用耗时，超阈值记为 slow；
 * - 渲染层 console.error 与未捕获异常；
 * - 进程级 ready / shutdown / uncaughtException。
 *
 * 这一页只读 + 一个「清空」动作。它回答的是「刚才卡的时候，到底慢在哪」，
 * 所以重点是**按功能聚合的耗时**和**时间线**，而不是日志全文。
 */

const REFRESH_MS = 5000;

type SortKey = 'cost' | 'avg' | 'max' | 'count';

export function PerformancePage() {
  const [details, setDetails] = useState<ConfigWebPerformanceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn'>('all');
  const RefreshIcon = appIcons.refresh;
  const TrashIcon = appIcons.trash;

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetails(await readPerformanceDetails({ limit: 200, buckets: 40, timeline: 180 }));
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 自动刷新只在页面可见时跑：后台标签页不该继续拉数据。
  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  async function handleClear() {
    try {
      await clearPerformanceLogs();
      await load();
    } catch (clearError) {
      setError(formatError(clearError));
    }
  }

  const buckets = useMemo(() => sortBuckets(details?.buckets ?? [], sortKey), [details, sortKey]);
  const events = useMemo(
    () => (details?.events ?? []).filter((item) => levelFilter === 'all' || item.level === levelFilter),
    [details, levelFilter],
  );

  if (loading && !details) {
    return (
      <PageFrame title="Performance">
        <Empty description="正在读取性能数据…" />
      </PageFrame>
    );
  }

  if (details && !details.available) {
    return (
      <PageFrame title="Performance">
        <Alert message="当前宿主读不到性能数据：诊断日志由桌面运行时写入本机系统临时目录，浏览器宿主（config-web）没有这份数据。" />
      </PageFrame>
    );
  }

  const totals = details?.totals;
  const timeline = details?.timeline ?? [];

  return (
    <PageFrame
      title="Performance"
      path={details?.dir}
      actions={
        <div className="toolbar">
          <Button
            pressed={auto}
            title={auto ? '自动刷新已开启，点击暂停' : '自动刷新已暂停，点击恢复'}
            icon={<span className={`perf-auto-dot${auto ? ' perf-auto-dot-on' : ''}`} aria-hidden="true" />}
            onClick={() => setAuto((prev) => !prev)}
          >
            自动刷新
          </Button>
          <Button icon={<RefreshIcon size={14} strokeWidth={2} />} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            variant="danger"
            icon={<TrashIcon size={14} />}
            title="清空本机性能日志"
            onClick={() => void handleClear()}
          >
            清空
          </Button>
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}

      <div className="perf-summary">
        <PerfStat label="事件" value={totals?.events ?? 0} />
        <PerfStat label="错误" value={totals?.errors ?? 0} tone={totals?.errors ? 'danger' : undefined} />
        <PerfStat label="慢调用" value={totals?.slowCalls ?? 0} tone={totals?.slowCalls ? 'warn' : undefined} />
        <PerfStat
          label="采样点"
          value={totals?.samples ?? 0}
          hint={totals?.hiddenSamples ? `另有 ${totals.hiddenSamples} 帧窗口不可见，不记卡顿` : undefined}
        />
        <PerfStat label="观测时长" value={formatSpan(totals?.spanMs ?? 0)} />
        <PerfStat label="未落盘" value={details?.pending ?? 0} />
      </div>

      <section className="perf-section">
        <header className="perf-section-head">
          <h2>渲染时间线</h2>
          <span className="perf-hint">每秒一个采样点；柱高 = 主线程被占用的毫秒数</span>
        </header>
        {timeline.length === 0 ? (
          <Empty description="还没有采样数据。打开任意对话页，几秒后就会开始记录。" />
        ) : (
          <>
            <TimelineChart points={timeline} />
            <TimelineLegend points={timeline} />
          </>
        )}
      </section>

      <section className="perf-section">
        <header className="perf-section-head">
          <h2>按功能聚合</h2>
          <div className="perf-toolbar">
            {(['cost', 'avg', 'max', 'count'] as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`perf-chip ${sortKey === key ? 'perf-chip-active' : ''}`}
                onClick={() => setSortKey(key)}
              >
                {SORT_LABEL[key]}
              </button>
            ))}
          </div>
        </header>
        {buckets.length === 0 ? (
          <Empty description="还没有通道耗时数据。" />
        ) : (
          <table className="perf-table">
            <thead>
              <tr>
                <th>功能</th>
                <th>调用</th>
                <th>平均</th>
                <th>最慢</th>
                <th>慢调用</th>
                <th>失败</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={`${bucket.scope}:${bucket.event}`}>
                  <td className="perf-cell-name">
                    <span className="perf-scope">{bucket.scope}</span>
                    <span className="perf-event">{bucket.event}</span>
                  </td>
                  <td>{bucket.count}</td>
                  <td className={bucket.avgMs >= 300 ? 'perf-slow' : undefined}>{bucket.avgMs}ms</td>
                  <td className={bucket.maxMs >= 1000 ? 'perf-slow' : undefined}>{bucket.maxMs}ms</td>
                  <td>{bucket.slow || ''}</td>
                  <td className={bucket.fails ? 'perf-slow' : undefined}>{bucket.fails || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="perf-section">
        <header className="perf-section-head">
          <h2>最近事件</h2>
          <div className="perf-toolbar">
            {(['all', 'error', 'warn'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={`perf-chip ${levelFilter === key ? 'perf-chip-active' : ''}`}
                onClick={() => setLevelFilter(key)}
              >
                {key === 'all' ? '全部' : key === 'error' ? '错误' : '警告'}
              </button>
            ))}
          </div>
        </header>
        {events.length === 0 ? (
          <Empty description="没有匹配的事件。" />
        ) : (
          <ul className="perf-events">
            {events.map((item, index) => (
              <li key={`${item.at}-${item.scope}-${item.event}-${index}`} className="perf-event-row">
                <span className="perf-time">{formatTime(item.at)}</span>
                <Tag tone={item.level === 'error' ? 'red' : item.level === 'warn' ? 'blue' : 'default'}>
                  {item.level}
                </Tag>
                <span className="perf-scope">{item.scope}</span>
                <span className="perf-event">{item.event}</span>
                <span className="perf-event-meta">{eventMeta(item)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="perf-section">
        <header className="perf-section-head">
          <h2>日志文件</h2>
          <span className="perf-hint">系统临时目录，开机自动清空；也可以直接 tail / jq</span>
        </header>
        {details?.files.length ? (
          <ul className="perf-files">
            {details.files.map((file) => (
              <li key={file.name}>
                <span className="perf-event">{file.name}</span>
                <span className="perf-event-meta">
                  {formatBytes(file.bytes)} · {formatTime(file.modifiedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty description="还没有日志文件。" />
        )}
      </section>
    </PageFrame>
  );
}

const SORT_LABEL: Record<SortKey, string> = {
  cost: '总耗时',
  avg: '平均',
  max: '最慢',
  count: '调用数',
};

function sortBuckets(buckets: ConfigWebPerfBucket[], key: SortKey): ConfigWebPerfBucket[] {
  const sorted = [...buckets];
  sorted.sort((a, b) => {
    if (key === 'avg') return b.avgMs - a.avgMs;
    if (key === 'max') return b.maxMs - a.maxMs;
    if (key === 'count') return b.count - a.count;
    return b.avgMs * b.count - a.avgMs * a.count;
  });
  return sorted;
}

function PerfStat({
  label,
  value,
  tone,
  hint
}: {
  label: string;
  value: number | string;
  tone?: 'warn' | 'danger';
  hint?: string;
}) {
  return (
    <div className={`perf-stat ${tone ? `perf-stat-${tone}` : ''}`} title={hint}>
      <div className="perf-stat-value">{value}</div>
      <div className="perf-stat-label">{label}</div>
    </div>
  );
}

/**
 * 极简柱状图：不引图表库，用一个 flex 容器按 lag 高度画。
 * 超过 100ms 标红（人开始能感觉到卡），超过 500ms 标橙。
 */
function TimelineChart({ points }: { points: ConfigWebPerfTimelinePoint[] }) {
  const max = Math.max(100, ...points.map((point) => point.lag + point.long));
  return (
    <div className="perf-chart">
      {points.map((point, index) => {
        const value = point.lag + point.long;
        const height = Math.max(1, Math.round((value / max) * 100));
        const tone = value >= 500 ? 'bad' : value >= 100 ? 'warn' : 'ok';
        return (
          <span
            key={`${point.at}-${index}`}
            className={`perf-bar perf-bar-${tone}`}
            style={{ height: `${height}%` }}
            title={`${formatTime(point.at)} · lag ${point.lag}ms · long ${point.long}ms · dom ${point.dom}`}
          />
        );
      })}
    </div>
  );
}

function TimelineLegend({ points }: { points: ConfigWebPerfTimelinePoint[] }) {
  const worst = points.reduce((acc, point) => Math.max(acc, point.lag + point.long), 0);
  const recent = points.slice(-30);
  const avg = recent.length
    ? Math.round(recent.reduce((sum, point) => sum + point.lag + point.long, 0) / recent.length)
    : 0;
  const dom = points.at(-1)?.dom ?? 0;
  const heap = points.at(-1)?.heapMB;
  return (
    <div className="perf-legend">
      <span>最慢 {worst}ms</span>
      <span>近 30 秒均值 {avg}ms</span>
      <span>DOM {dom}</span>
      {typeof heap === 'number' ? <span>堆 {heap}MB</span> : null}
    </div>
  );
}

function eventMeta(item: ConfigWebPerfEvent): string {
  const parts: string[] = [];
  if (typeof item.ms === 'number') parts.push(`${item.ms}ms`);
  if (typeof item.lag === 'number') parts.push(`lag ${item.lag}ms`);
  if (typeof item.long === 'number') parts.push(`long ${item.long}ms`);
  if (typeof item.count === 'number') parts.push(`${item.count} 条`);
  if (item.error) parts.push(truncate(item.error, 120));
  return parts.join(' · ');
}

function formatError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message || '未知错误';
}

function formatTime(at: number): string {
  if (!at) return '—';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;
}

function formatSpan(ms: number): string {
  if (!ms) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
