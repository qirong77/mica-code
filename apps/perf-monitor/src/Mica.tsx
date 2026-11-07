import { useCallback, useEffect, useState } from 'react';
import { Alert, Empty, Skeleton, Table, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import type {
  Health,
  MicaChannelStat,
  MicaHostUsage,
  MicaOverview,
  MicaPageStat,
  MicaProcessKind,
  MicaScopeFreshness,
  Range,
} from '../shared/types';
import { MicaHeapChart, MicaMemoryChart } from './Charts';
import { dateTime, duration, memory, number, percent } from './format';
import { ErrorNotice, HealthBadge, Icon, Panel } from './UI';

async function fetchMica(day: string, range: Range, signal: AbortSignal): Promise<MicaOverview> {
  const response = await fetch(`/api/mica?day=${encodeURIComponent(day)}&range=${range}`, {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}），请检查采集服务后重试。`);
  return response.json() as Promise<MicaOverview>;
}

/** Mica 自身指标来自诊断日志，与主机资源采集分开轮询，页面不可见时暂停。 */
export function useMica(day: string, range: Range) {
  const [state, setState] = useState<{ key: string; data: MicaOverview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const key = `${day}:${range}`;
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!day) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      setLoading(true);
      setError(null);
      try {
        const data = await fetchMica(day, range, controller.signal);
        if (!disposed) setState({ key, data });
      } catch (cause) {
        if (!disposed && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Mica 指标加载失败，请重试。');
      } finally {
        if (!disposed) {
          inFlight = false;
          setLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 20_000);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [day, range, key, revision]);
  return { data: state?.key === key ? state.data : null, loading, error, retry };
}

const kindColors = ['#64d8e8', '#b4a1dc', '#93bcba', '#e5bf79', '#82a9d1', '#c88f8f'];

function MicaMetrics({ mica }: { mica: MicaOverview }) {
  const total = Math.max(1, mica.kinds.reduce((sum, kind) => sum + kind.footprintMb, 0));
  const slowest = [...mica.channels].sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0))[0];
  return (
    <div className="metric-grid">
      <article className="metric-card mica-metric">
        <div className="metric-top">
          <span>
            <Icon name="memory" size={17} />
            Mica 进程 Footprint
          </span>
          <span className="metric-tag">{mica.totals.processes} 个进程</span>
        </div>
        <div className="metric-value">
          {memory(mica.totals.footprintMb)}
          <span>已记录合计</span>
        </div>
        <div className="mica-kind-bar">
          {mica.kinds.map((kind, index) => (
            <i
              key={kind.kind}
              style={{ width: `${(kind.footprintMb / total) * 100}%`, background: kindColors[index % kindColors.length] }}
              title={`${kind.kind} ${memory(kind.footprintMb)}`}
            />
          ))}
        </div>
        <div className="metric-footer">
          <span>{mica.kinds[0]?.kind ?? '—'} 最多 · {mica.totals.appServers} 个会话宿主</span>
          <span>CPU {percent(mica.totals.cpuPct)}</span>
        </div>
      </article>
      <article className="metric-card mica-metric">
        <div className="metric-top">
          <span>
            <Icon name="cpu" size={17} />
            宿主内存
          </span>
          <span className="metric-tag">RSS</span>
        </div>
        <div className="metric-value">
          {mica.hostSummary.activeHosts}
          <span className="metric-unit">个活跃宿主</span>
        </div>
        <div className="metric-detail">
          窗口内出现过 {mica.hostSummary.windowHosts} 个
          <span> · {mica.hostSummary.shortLived} 个只采到一两次</span>
        </div>
        <div className="metric-footer">
          <span>峰值 {memory(mica.hostSummary.peakHostRssMb)}</span>
          <span title={mica.hostSummary.peakHostLabel ?? ''}>{mica.hostSummary.peakHostLabel ?? '—'}</span>
        </div>
      </article>
      <article className="metric-card mica-metric">
        <div className="metric-top">
          <span>
            <Icon name="load" size={17} />
            渲染帧间隔
          </span>
          <span className="metric-tag">{number(mica.renderer.samples, 0)} 个采样</span>
        </div>
        <div className="metric-value">
          {number(mica.renderer.lagP99)}
          <span className="metric-unit">ms p99</span>
        </div>
        <div className="metric-detail">
          p50 {number(mica.renderer.lagP50)} · p95 {number(mica.renderer.lagP95)}
          <span> · 超 32ms {number(mica.renderer.over32, 0)} 帧</span>
        </div>
        <div className="metric-footer">
          {mica.renderer.worst == null ? (
            <span>窗口内没有可见采样</span>
          ) : (
            <span>
              最差 {number(mica.renderer.worst)} ms · {dateTime(mica.renderer.worstAt, true)}
            </span>
          )}
        </div>
      </article>
      <article className="metric-card mica-metric">
        <div className="metric-top">
          <span>
            <Icon name="arrow" size={17} />
            主机调用
          </span>
          <span className="metric-tag">{number(mica.invoke.calls, 0)} 次</span>
        </div>
        <div className="metric-value">
          {number(mica.invoke.slow, 0)}
          <span className="metric-unit">次慢调用</span>
        </div>
        <div className="metric-detail">
          失败 {number(mica.invoke.failed, 0)} 次
          <span> · 慢阈值 300ms</span>
        </div>
        <div className="metric-footer">
          {slowest ? (
            <span title={slowest.channel}>
              最慢 {slowest.channel} · {number(slowest.maxMs, 0)} ms
            </span>
          ) : (
            <span>窗口内没有调用记录</span>
          )}
        </div>
      </article>
    </div>
  );
}

function MicaSignals({ findings }: { findings: MicaOverview['findings'] }) {
  if (!findings.length)
    return (
      <div className="signal-strip">
        <HealthBadge health="ok" />
        <span className="text-muted">当前快照与所选窗口没有触发 Mica 侧的阈值。</span>
      </div>
    );
  return (
    <div className="signal-strip">
      <div className="signal-health">
        <HealthBadge health={worst(findings.map((finding) => finding.level))} />
        <span className="eyebrow">MICA SIGNALS</span>
      </div>
      <div className="signal-findings">
        {findings.map((finding, index) => (
          <div className={`signal-finding finding-${finding.level}`} key={`${index}:${finding.title}`}>
            <span className="finding-dot" />
            <div>
              <strong>{finding.title}</strong>
              <p>{finding.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function worst(levels: Health[]): Health {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  if (levels.includes('ok')) return 'ok';
  return 'unknown';
}

function KindTable({ kinds }: { kinds: MicaProcessKind[] }) {
  const columns: TableColumnsType<MicaProcessKind> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 150,
      render: (value: string) => <span className="mica-kind-name">{value}</span>,
    },
    { title: '进程数', dataIndex: 'count', width: 80, align: 'right', render: (v: number) => number(v, 0) },
    {
      title: 'Footprint',
      dataIndex: 'footprintMb',
      width: 120,
      align: 'right',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.footprintMb - b.footprintMb,
      render: (value: number) => <span className="numeric strong">{memory(value)}</span>,
    },
    { title: 'RSS', dataIndex: 'rssMb', width: 110, align: 'right', render: (v: number) => memory(v) },
    { title: 'CPU', dataIndex: 'cpuPct', width: 90, align: 'right', render: (v: number | null) => percent(v) },
    {
      title: '明细',
      key: 'processes',
      render: (_, row) => (
        <div className="mica-chips">
          {row.processes.slice(0, 8).map((process) => (
            <Tooltip key={process.pid} title={process.command ?? `${process.name} · PID ${process.pid}`}>
              <span className={`mica-chip ${process.orphan ? 'mica-chip-alert' : ''}`}>
                {process.session ? process.session.slice(-13) : `PID ${process.pid}`}
                <b>{memory(process.footprintMb)}</b>
                {process.orphan && <i>父进程已退出</i>}
              </span>
            </Tooltip>
          ))}
          {row.processes.length > 8 && <span className="mica-chip">+{row.processes.length - 8}</span>}
        </div>
      ),
    },
  ];
  return (
    <Table
      rowKey="kind"
      size="middle"
      pagination={false}
      columns={columns}
      dataSource={kinds}
      scroll={{ x: 720 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有记录到 Mica 进程" /> }}
    />
  );
}

function HostTable({ hosts }: { hosts: MicaHostUsage[] }) {
  const columns: TableColumnsType<MicaHostUsage> = [
    {
      title: '宿主',
      key: 'host',
      width: 190,
      render: (_, row) => (
        <span className="mica-host-cell">
          <Tag color={row.host === 'app-server' ? 'cyan' : row.host === 'main' ? 'purple' : row.host === 'runtime' ? 'green' : 'default'}>
            {row.host}
          </Tag>
          <b>PID {row.pid}</b>
        </span>
      ),
    },
    {
      title: '会话 / 模型',
      key: 'session',
      render: (_, row) => (
        <span className="mica-session-cell">
          <span>{row.session ? row.session.slice(-20) : row.host === 'main' ? `${row.windows ?? '—'} 个窗口` : '—'}</span>
          <small>
            {row.model ?? ''}
            {row.turn ? ` · turn ${row.turn.slice(0, 8)}` : ''}
            {row.hosts !== null ? ` · 挂了 ${row.hosts} 个宿主` : ''}
            {row.busy !== null ? ` · ${row.busy} 忙` : ''}
          </small>
        </span>
      ),
    },
    {
      title: 'RSS',
      dataIndex: 'rssMb',
      width: 110,
      align: 'right',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.rssMb - b.rssMb,
      render: (value: number) => <span className="numeric strong">{memory(value)}</span>,
    },
    {
      title: '窗口内变化',
      dataIndex: 'growthMb',
      width: 130,
      align: 'right',
      render: (value: number | null) =>
        value == null ? (
          '—'
        ) : (
          <span className={value >= 100 ? 'text-amber' : undefined}>
            {value > 0 ? '+' : ''}
            {memory(value)}
          </span>
        ),
    },
    {
      title: 'Electron 构成',
      key: 'byType',
      render: (_, row) =>
        row.byType ? (
          <span className="mica-bytype">
            {Object.entries(row.byType)
              .filter(([, value]) => value > 0)
              .map(([key, value]) => `${key} ${Math.round(value)}M`)
              .join(' · ')}
          </span>
        ) : (
          '—'
        ),
    },
    { title: '最后采样', dataIndex: 'lastAt', width: 130, render: (value: string) => dateTime(value, true) },
    { title: '采样', dataIndex: 'samples', width: 70, align: 'right', render: (value: number) => number(value, 0) },
  ];
  return (
    <Table
      rowKey="pid"
      size="middle"
      pagination={false}
      columns={columns}
      dataSource={hosts}
      scroll={{ x: 820 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="窗口内没有活跃宿主采样" /> }}
    />
  );
}

function PageTable({ pages }: { pages: MicaPageStat[] }) {
  const columns: TableColumnsType<MicaPageStat> = [
    {
      title: '窗口',
      key: 'page',
      render: (_, row) => (
        <span className="mica-session-cell">
          <span>{row.pageId.slice(0, 8)}</span>
          <small>{row.sid ? row.sid.slice(-20) : '无会话绑定'}</small>
        </span>
      ),
    },
    { title: 'JS 堆', dataIndex: 'heapMb', width: 100, align: 'right', render: (v: number | null) => memory(v) },
    { title: '分钟内峰值', dataIndex: 'heapMaxMb', width: 110, align: 'right', render: (v: number | null) => memory(v) },
    {
      title: '窗口内变化',
      key: 'growth',
      width: 120,
      align: 'right',
      render: (_, row) =>
        row.heapMb == null || row.heapFirstMb == null ? (
          '—'
        ) : (
          <span className={row.heapMb - row.heapFirstMb >= 50 ? 'text-amber' : undefined}>
            {row.heapMb - row.heapFirstMb > 0 ? '+' : ''}
            {memory(row.heapMb - row.heapFirstMb)}
          </span>
        ),
    },
    { title: 'DOM 节点', dataIndex: 'dom', width: 100, align: 'right', render: (v: number | null) => number(v, 0) },
    { title: '行', dataIndex: 'rows', width: 70, align: 'right', render: (v: number | null) => number(v, 0) },
    { title: '最后采样', dataIndex: 'lastAt', width: 130, render: (value: string) => dateTime(value, true) },
  ];
  return (
    <Table
      rowKey="pageId"
      size="small"
      pagination={false}
      columns={columns}
      dataSource={pages}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有渲染采样" /> }}
    />
  );
}

function ChannelTable({ channels }: { channels: MicaChannelStat[] }) {
  const columns: TableColumnsType<MicaChannelStat> = [
    { title: '通道', dataIndex: 'channel', render: (value: string) => <span className="mica-channel">{value}</span> },
    {
      title: '调用',
      dataIndex: 'calls',
      width: 80,
      align: 'right',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.calls - b.calls,
      render: (value: number) => number(value, 0),
    },
    {
      title: '慢',
      dataIndex: 'slow',
      width: 70,
      align: 'right',
      sorter: (a, b) => a.slow - b.slow,
      render: (value: number) => <span className={value ? 'text-amber' : undefined}>{number(value, 0)}</span>,
    },
    {
      title: '失败',
      dataIndex: 'failed',
      width: 70,
      align: 'right',
      render: (value: number) => <span className={value ? 'text-amber' : undefined}>{number(value, 0)}</span>,
    },
    { title: 'p95', dataIndex: 'p95Ms', width: 80, align: 'right', render: (v: number | null) => `${number(v, 0)} ms` },
    { title: '最大', dataIndex: 'maxMs', width: 90, align: 'right', sorter: (a, b) => (a.maxMs ?? 0) - (b.maxMs ?? 0), render: (v: number | null) => `${number(v, 0)} ms` },
  ];
  return (
    <Table
      rowKey="channel"
      size="small"
      pagination={false}
      columns={columns}
      dataSource={channels}
      scroll={{ y: 360 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有调用记录" /> }}
    />
  );
}

function ScopeList({ scopes }: { scopes: MicaScopeFreshness[] }) {
  const health: Record<MicaScopeFreshness['state'], Health> = { running: 'ok', stale: 'warning', unavailable: 'unknown' };
  const labels: Record<MicaScopeFreshness['state'], string> = {
    running: '在写',
    stale: '已停',
    unavailable: '没有文件',
  };
  return (
    <div className="mica-scope-list">
      {scopes.map((scope) => (
        <div className="mica-scope" key={scope.id}>
          <div className="mica-scope-head">
            <strong>{scope.scope}</strong>
            <HealthBadge health={health[scope.state]} label={labels[scope.state]} />
          </div>
          <div className="mica-scope-meta">
            <span>{number(scope.samples, 0)} 条</span>
            <span>{dateTime(scope.lastAt, true)}</span>
            <span>{memory(scope.bytes / 1048576)}</span>
          </div>
          <p>{scope.note}</p>
        </div>
      ))}
    </div>
  );
}

export function MicaPage({ day, range }: { day: string; range: Range }) {
  const mica = useMica(day, range);
  if (!mica.data)
    return (
      <>
        <ErrorNotice error={mica.error} retry={mica.retry} />
        <div className="panel loading-chart">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      </>
    );
  const data = mica.data;
  return (
    <div className="mica-page">
      <MicaMetrics mica={data} />
      <MicaSignals findings={data.findings} />
      <Panel
        title="宿主内存走势"
        eyebrow="MICA HOST MEMORY"
        extra={
          <span className="caption">
            {data.hostSummary.activeHosts} 个活跃 · 峰值 {memory(data.hostSummary.peakHostRssMb)}
          </span>
        }
      >
        {data.memory.length ? (
          <MicaMemoryChart points={data.memory} />
        ) : (
          <div className="chart-empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该窗口没有 mem 采样" />
          </div>
        )}
        <div className="table-note">{data.memoryNote}</div>
      </Panel>
      <Panel
        title="进程构成"
        eyebrow="PROCESS BREAKDOWN"
        extra={<span className="caption">{data.processAt ? `快照 ${dateTime(data.processAt, true)}` : '无资源快照'}</span>}
      >
        <KindTable kinds={data.kinds} />
        <div className="table-note">
          来自本机资源采集的最后一份快照；footprint 与宿主自报的 RSS 是两套口径，不能相加当物理内存。
        </div>
      </Panel>
      <Panel
        title="活跃宿主"
        eyebrow="LIVE HOSTS"
        extra={<span className="caption">10 分钟内仍有采样</span>}
      >
        <HostTable hosts={data.hosts} />
        <div className="table-note">
          会话宿主来自 app-server；短命宿主（只采到一两次）不计入列表，本次窗口共 {data.hostSummary.shortLived} 个。
        </div>
      </Panel>
      <div className="mica-split">
        <Panel
          title="渲染健康"
          eyebrow="RENDERER"
          extra={<span className="caption">{number(data.renderer.samples, 0)} 个可见采样</span>}
        >
          <div className="mica-stat-row">
            <div>
              <span className="eyebrow">P95</span>
              <strong>{number(data.renderer.lagP95)} ms</strong>
            </div>
            <div>
              <span className="eyebrow">P99</span>
              <strong>{number(data.renderer.lagP99)} ms</strong>
            </div>
            <div>
              <span className="eyebrow">超 32ms</span>
              <strong className={data.renderer.over32 ? 'text-amber' : undefined}>{number(data.renderer.over32, 0)}</strong>
            </div>
            <div>
              <span className="eyebrow">超 100ms</span>
              <strong className={data.renderer.over100 ? 'text-amber' : undefined}>{number(data.renderer.over100, 0)}</strong>
            </div>
            <div>
              <span className="eyebrow">丢弃采样</span>
              <strong>{number(data.renderer.dropped, 0)}</strong>
            </div>
          </div>
          {data.renderer.heap.length ? (
            <MicaHeapChart points={data.renderer.heap} />
          ) : (
            <div className="chart-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有渲染堆采样" />
            </div>
          )}
          <div className="table-note">堆只来自主窗口的渲染采样；Bun 宿主的 heap 不可信，宿主内存请看 RSS。</div>
        </Panel>
        <Panel title="页面实例" eyebrow="PAGES">
          <PageTable pages={data.renderer.pages} />
        </Panel>
      </div>
      <Panel
        title="主机调用耗时"
        eyebrow="HOST CHANNELS"
        extra={
          <span className="caption">
            {number(data.invoke.calls, 0)} 次 · 慢 {number(data.invoke.slow, 0)} · 失败 {number(data.invoke.failed, 0)}
          </span>
        }
      >
        <ChannelTable channels={data.channels} />
        <div className="table-note">
          按调用次数排序，最多 24 个通道。慢与失败是同一批调用的附加判定，不重复计入次数；p95 只统计成功调用。
        </div>
      </Panel>
      <div className="mica-split">
        <Panel title="生命周期与会话数据" eyebrow="LIFECYCLE">
          <dl className="coverage-definition">
            <div>
              <dt>宿主启动</dt>
              <dd>{number(data.lifecycle.boots, 0)} 次</dd>
            </div>
            <div>
              <dt>宿主退出</dt>
              <dd>{number(data.lifecycle.shutdowns, 0)} 次</dd>
            </div>
            <div>
              <dt>日志中仍开着</dt>
              <dd>{number(data.lifecycle.openPids, 0)} 个</dd>
            </div>
            <div>
              <dt>最后一次启动</dt>
              <dd>{dateTime(data.lifecycle.lastBootAt, true)}</dd>
            </div>
            <div>
              <dt>窗口回收</dt>
              <dd>
                {number(data.chat.reaped, 0)} 次
                {data.chat.maxIdleSeconds != null ? ` · 最长闲置 ${duration(data.chat.maxIdleSeconds)}` : ''}
              </dd>
            </div>
            <div>
              <dt>会话快照</dt>
              <dd>
                {number(data.sessions.count, 0)} 个 · {memory(data.sessions.totalMb)}
              </dd>
            </div>
          </dl>
          {data.sessions.largest.length > 0 && (
            <div className="mica-largest">
              <span className="eyebrow">最大的会话文件</span>
              {data.sessions.largest.map((session) => (
                <div key={session.id}>
                  <span>{session.id}</span>
                  <b>{memory(session.sizeMb)}</b>
                  <small>{dateTime(session.updatedAt, true)}</small>
                </div>
              ))}
            </div>
          )}
          {data.sessions.error && <p className="mica-path-note">{data.sessions.error}</p>}
          <div className="mica-paths">
            <div>
              <span>诊断日志</span>
              <code>{data.paths.logs}</code>
            </div>
            <div>
              <span>会话目录</span>
              <code>{data.paths.sessions}</code>
            </div>
            {data.paths.desktopApp && (
              <div>
                <span>运行中的应用</span>
                <code>{data.paths.desktopApp}</code>
              </div>
            )}
          </div>
        </Panel>
        <Panel title="诊断数据自检" eyebrow="MICA COVERAGE">
          <ScopeList scopes={data.scopes} />
        </Panel>
      </div>
      {data.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="阅读这些数字的前提"
          description={
            <ul className="warning-list">
              {data.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          }
        />
      )}
    </div>
  );
}
