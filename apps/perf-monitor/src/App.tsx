import { useEffect, useState } from 'react';
import { Alert, Button, ConfigProvider, Empty, Segmented, Select, Skeleton, Switch, Tag, Tooltip, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { GroupSummary, IncidentSummary, Overview, ProcessRecord, Range } from '../shared/types';
import { TimelineChart } from './Charts';
import { Coverage } from './Coverage';
import { IncidentDrawer, IncidentList } from './Incidents';
import { ProcessDrawer, ProcessTable } from './Processes';
import { dateTime, duration, memory, number, percent } from './format';
import { useMonitor } from './hooks';
import { ErrorNotice, FootprintInfo, HealthBadge, Icon, Panel, type IconName } from './UI';
import './styles.css';

type Page = 'overview' | 'processes' | 'incidents' | 'coverage';
const navigation: { key: Page; label: string; icon: IconName; eyebrow: string; description: string }[] = [
  {
    key: 'overview',
    label: '性能全景',
    icon: 'overview',
    eyebrow: 'SYSTEM OVERVIEW',
    description: '沿着时间线，了解这台机器正在经历什么。',
  },
  {
    key: 'processes',
    label: '进程分析',
    icon: 'processes',
    eyebrow: 'PROCESS EXPLORER',
    description: '从应用到进程实例，追踪资源占用与变化。',
  },
  {
    key: 'incidents',
    label: '异常现场',
    icon: 'incidents',
    eyebrow: 'INCIDENT EXPLORER',
    description: '保留触发时刻的系统状态与原始证据。',
  },
  {
    key: 'coverage',
    label: '采集覆盖',
    icon: 'coverage',
    eyebrow: 'COLLECTION HEALTH',
    description: '看清数据从哪里来，以及哪些指标仍然缺失。',
  },
];

function MetricTiles({ overview }: { overview: Overview }) {
  const system = overview.latest?.sys;
  const swapRatio =
    system?.swap_used_mb != null && system.swap_total_mb != null && system.swap_total_mb > 0
      ? Math.max(0, Math.min(100, (system.swap_used_mb / system.swap_total_mb) * 100))
      : null;
  return (
    <div className="metric-grid">
      <article className="metric-card metric-memory">
        <div className="metric-top">
          <span>
            <Icon name="memory" size={17} />
            内存与 Swap
          </span>
          <Tooltip title="显示采样器记录的原始内存压力值；健康判断使用采集服务返回的信号，不单凭 Swap 总量推断卡顿。">
            <span className="metric-tag">压力 {number(system?.pressure, 0)}</span>
          </Tooltip>
        </div>
        <div className="metric-value">
          {memory(system?.swap_used_mb)}
          <span>Swap 已用</span>
        </div>
        <div className="meter-track">
          <i style={{ width: swapRatio == null ? '0%' : `${swapRatio}%` }} />
        </div>
        <div className="metric-footer">
          <span>总量 {memory(system?.swap_total_mb)}</span>
          <span>压缩 {memory(system?.compressor_mb)}</span>
        </div>
      </article>
      <article className="metric-card metric-cpu">
        <div className="metric-top">
          <span>
            <Icon name="cpu" size={17} />
            主机 CPU
          </span>
          <span className="metric-tag tag-current">
            <i />
            当前
          </span>
        </div>
        <div className="metric-value">
          {overview.liveCpuPct == null ? '—' : number(overview.liveCpuPct)}
          <span className="metric-unit">{overview.liveCpuPct == null ? '' : '%'}</span>
        </div>
        <div className="metric-detail">
          {number(overview.host.cpuCores, 0)} 个逻辑核 <span>· OS 计数器差值</span>
        </div>
        <div className="metric-footer">
          <span>当前主机读数，不随历史日期切换</span>
        </div>
      </article>
      <article className="metric-card metric-disk">
        <div className="metric-top">
          <span>
            <Icon name="disk" size={17} />
            磁盘空闲
          </span>
          <span className="metric-tag">已用 {percent(system?.disk_used_pct)}</span>
        </div>
        <div className="metric-value">
          {number(system?.disk_free_gb)}
          <span className="metric-unit">{system?.disk_free_gb == null ? '' : 'GB'}</span>
        </div>
        <div className="metric-detail">
          {system?.disk ? `${number(system.disk.mb_s, 2)} MB/s` : '—'}
          <span> 系统磁盘吞吐</span>
        </div>
        <div className="metric-footer">
          <span>全系统吞吐，不代表单进程写入</span>
        </div>
      </article>
      <article className="metric-card metric-load">
        <div className="metric-top">
          <span>
            <Icon name="load" size={17} />
            系统负载
          </span>
          <span className="metric-tag">1 / 5 / 15 min</span>
        </div>
        <div className="metric-value">
          {number(system?.load[0], 2)}
          <span className="metric-unit">load</span>
        </div>
        <div className="metric-detail">
          <span>5 min </span>
          {number(system?.load[1], 2)}
          <span className="load-separator">/</span>
          <span>15 min </span>
          {number(system?.load[2], 2)}
        </div>
        <div className="metric-footer">
          <span>样本运行时长 {system?.uptime_h == null ? '—' : duration(system.uptime_h * 3600)}</span>
        </div>
      </article>
    </div>
  );
}

function Groups({ groups, expanded = false }: { groups: GroupSummary[]; expanded?: boolean }) {
  const sorted = [...groups].sort((a, b) => b.footprintMb - a.footprintMb);
  const max = Math.max(1, ...sorted.map((group) => group.footprintMb));
  return (
    <div className="group-list">
      {(expanded ? sorted : sorted.slice(0, 6)).map((group, index) => (
        <div className="group-item" key={group.name}>
          <div className="group-name">
            <span className={`group-dot group-color-${index % 4}`} />
            <strong title={group.name}>{group.name}</strong>
            <span className="numeric">{memory(group.footprintMb)}</span>
          </div>
          <div className="group-bar">
            <i
              className={`group-color-${index % 4}`}
              style={{ width: `${(Math.max(0, group.footprintMb) / max) * 100}%` }}
            />
          </div>
          <div className="group-meta">
            <span>{group.count} 个进程</span>
            <span>
              {expanded ? `CPU ${percent(group.cpuPct)} · ` : ''}
              {group.growthMb > 0 ? '+' : ''}
              {memory(group.growthMb)}
            </span>
          </div>
        </div>
      ))}
      {!groups.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无应用分组数据" />}
    </div>
  );
}

function Signals({ overview }: { overview: Overview }) {
  if (!overview.findings.length)
    return (
      <div className="signal-strip">
        <HealthBadge health={overview.health} />
        <span className="text-muted">暂无额外健康发现。高 Swap 用量或单次写入不单独作为卡顿结论。</span>
      </div>
    );
  return (
    <div className="signal-strip">
      <div className="signal-health">
        <HealthBadge health={overview.health} />
        <span className="eyebrow">HEALTH SIGNALS</span>
      </div>
      <div className="signal-findings">
        {overview.findings.map((finding, index) => (
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

function OverviewPage({
  overview,
  onProcess,
  onIncident,
  navigate,
}: {
  overview: Overview;
  onProcess: (process: ProcessRecord) => void;
  onIncident: (incident: IncidentSummary) => void;
  navigate: (page: Page) => void;
}) {
  const history = overview.history;
  const gaps = history.filter((point) => point.gap).length;
  const reboots = history.filter((point) => point.reboot).length;
  return (
    <>
      <MetricTiles overview={overview} />
      <Signals overview={overview} />
      <div className="overview-grid">
        <Panel
          title="资源时间线"
          eyebrow="HISTORICAL TELEMETRY"
          className="timeline-panel"
          extra={
            <span className="chart-sample-count">
              <span className="tiny-dot" />
              {number(overview.coverage.sampleCount, 0)} 个样本
            </span>
          }
        >
          <div className="chart-legend">
            <span>
              <i style={{ background: '#b6a2ef' }} />
              Swap
            </span>
            <span>
              <i style={{ background: '#7baff2' }} />
              压缩
            </span>
            <span>
              <i style={{ background: '#a4e6af' }} />
              空闲 / GPU
            </span>
            <span>
              <i style={{ background: '#718692' }} />
              Wired
            </span>
            <span>
              <i style={{ background: '#64d9e8' }} />
              换入 / 磁盘
            </span>
            <span>
              <i style={{ background: '#b6a2ef' }} />
              换出
            </span>
            <span>
              <i style={{ background: '#e5bf79' }} />
              负载
            </span>
          </div>
          {history.length ? (
            <TimelineChart history={history} />
          ) : (
            <div className="chart-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此时间段没有历史样本，请切换日期或范围" />
            </div>
          )}
          <div className="chart-footnote">
            <span>
              {reboots > 0 && <span className="text-amber">{reboots} 次重启 · </span>}
              {gaps > 0 ? (
                <span className="text-amber">{gaps} 处采样间断（阴影）</span>
              ) : (
                '缺失值保留为空，不填零或跨间断连线'
              )}
            </span>
            <span>拖动底部滑块缩放</span>
          </div>
        </Panel>
        <div className="overview-side">
          <Panel title="应用内存分布" eyebrow="APPLICATION GROUPS" extra={<FootprintInfo />}>
            <Groups groups={overview.groups} />
            <button className="panel-link" onClick={() => navigate('processes')}>
              查看进程分析 <Icon name="arrow" size={14} />
            </button>
          </Panel>
          <Panel
            title="异常现场"
            eyebrow="RECENT INCIDENTS"
            extra={<span className="count-pill">{overview.incidents.length}</span>}
          >
            <IncidentList incidents={overview.incidents} onSelect={onIncident} compact />
            {overview.incidents.length > 0 && (
              <button className="panel-link" onClick={() => navigate('incidents')}>
                查看所有现场 <Icon name="arrow" size={14} />
              </button>
            )}
          </Panel>
        </div>
      </div>
      <Panel
        title="进程资源排行"
        eyebrow="LATEST RECORDED SNAPSHOT"
        extra={
          <button className="text-button" onClick={() => navigate('processes')}>
            查看全部 <Icon name="arrow" size={14} />
          </button>
        }
      >
        <ProcessTable
          processes={overview.latest?.procs || []}
          onSelect={onProcess}
          sampleAt={overview.latest?.ts}
          compact
        />
        <div className="table-note">排名来自所选窗口的最后快照；进程 CPU 按单核计，100% ≈ 1 个逻辑核。</div>
      </Panel>
    </>
  );
}

function Cockpit() {
  const monitor = useMonitor();
  const [page, setPage] = useState<Page>(() => {
    const hash = window.location.hash.slice(1);
    return navigation.some((item) => item.key === hash) ? (hash as Page) : 'overview';
  });
  const [selectedProcess, setSelectedProcess] = useState<ProcessRecord | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<IncidentSummary | null>(null);
  const [now, setNow] = useState(Date.now());
  const overview = monitor.data;
  const current = navigation.find((item) => item.key === page)!;
  useEffect(() => {
    const update = () => {
      const hash = window.location.hash.slice(1);
      if (navigation.some((item) => item.key === hash)) setPage(hash as Page);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    document.title = `${current.label} · Mica 性能监控`;
  }, [current.label]);
  useEffect(() => {
    setSelectedProcess(null);
    setSelectedIncident(null);
  }, [monitor.day]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const historical = !!monitor.day && !!monitor.days.data?.latestDay && monitor.day !== monitor.days.data.latestDay;
  const age =
    overview?.ageSeconds == null ? null : Math.max(0, overview.ageSeconds + (now - (monitor.receivedAt || now)) / 1000);
  const stale = age != null && age > 180;
  const activeCollectors = overview?.collectors.filter((collector) => collector.state === 'running').length || 0;
  const dayOptions = [...new Set([...(monitor.days.data?.days || []), ...(monitor.day ? [monitor.day] : [])])]
    .sort()
    .reverse()
    .map((day) => ({ value: day, label: day === monitor.days.data?.latestDay ? `${day} · 最新` : day }));
  const navigate = (next: Page) => {
    setPage(next);
    history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  return (
    <div className="monitor-app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate('overview');
          }}
          aria-label="Mica 性能监控首页"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            MICA<small>PERFORMANCE</small>
          </span>
          <span className="brand-local">LOCAL</span>
        </a>
        <div className="sidebar-label">工作空间</div>
        <nav className="main-nav" aria-label="监控导航">
          {navigation.map((item) => (
            <button
              key={item.key}
              className={page === item.key ? 'active' : ''}
              onClick={() => navigate(item.key)}
              aria-current={page === item.key ? 'page' : undefined}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.key === 'incidents' && !!overview?.incidents.length && (
                <span className="nav-count">{overview.incidents.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-host">
            <span className="host-symbol">
              <Icon name="cpu" size={20} />
            </span>
            <div>
              <strong>{overview?.host.name || '本地主机'}</strong>
              <span>{overview?.host.platform || '等待连接'}</span>
            </div>
          </div>
          <div className="sidebar-status">
            <span className={`status-light ${overview ? 'connected' : ''}`} />
            {overview ? `${activeCollectors} 个采集器有数据` : '正在读取采集状态'}
          </div>
          <button className="sidebar-coverage" onClick={() => navigate('coverage')}>
            查看采集覆盖 <Icon name="arrow" size={13} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作空间</span>
            <span>/</span>
            <strong>本机监控</strong>
            <span className="read-only-label">只读</span>
          </div>
          <div className="topbar-actions">
            <Tooltip title="每 15 秒刷新接口；采样频率取决于采集器。页面不可见时暂停轮询。">
              <span className="auto-refresh-label">
                自动刷新{' '}
                <Switch
                  size="small"
                  checked={monitor.automatic}
                  onChange={monitor.setAutomatic}
                  aria-label="自动刷新，每 15 秒"
                />
              </span>
            </Tooltip>
            <span className="poll-interval">{monitor.automatic ? (monitor.visible ? '15s' : '已暂停') : '已关闭'}</span>
            <Button
              className="refresh-button"
              icon={<Icon name="refresh" size={16} />}
              loading={monitor.loading || monitor.days.loading}
              onClick={monitor.refresh}
            >
              刷新
            </Button>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow page-eyebrow">
                <span className="tiny-dot" />
                {current.eyebrow}
              </div>
              <h1>
                {current.label}
                <span className="title-period">.</span>
              </h1>
              <p>{current.description}</p>
            </div>
            <div className="host-summary">
              <span>{overview?.host.cpuModel || '正在连接本机采集服务'}</span>
              <strong>
                {overview
                  ? `${number(overview.host.cpuCores, 0)} 核 · ${memory(overview.host.memoryMb)} 内存`
                  : 'Mica performance monitor'}
              </strong>
            </div>
          </div>
          <section className="filter-bar" aria-label="监控数据范围">
            <div className="date-control">
              <span className="filter-label">采样日期</span>
              <Select
                aria-label="选择历史采样日期"
                value={monitor.day || undefined}
                options={dayOptions}
                placeholder="暂无采样日期"
                loading={monitor.days.loading}
                onChange={monitor.setDay}
                className="day-select"
                disabled={!dayOptions.length}
              />
            </div>
            <Segmented
              className="range-control"
              aria-label="选择时间范围"
              value={monitor.range}
              onChange={(value) => monitor.setRange(value as Range)}
              options={[
                { label: '1 小时', value: '1h' },
                { label: '6 小时', value: '6h' },
                { label: '24 小时', value: '24h' },
                { label: '7 天', value: '7d' },
              ]}
            />
            <div className="freshness">
              <Tooltip
                title={
                  historical
                    ? '正在查看历史记录；历史样本距今时间不表示采集器当前停机。'
                    : '样本距今超过 3 分钟时提示数据过期。接口刷新频率不等于采样频率。'
                }
              >
                <span>
                  <HealthBadge
                    health={historical ? 'unknown' : !overview?.latest ? 'unknown' : stale ? 'warning' : 'ok'}
                    label={historical ? '历史快照' : !overview?.latest ? '等待样本' : stale ? '数据过期' : '数据已采集'}
                  />
                </span>
              </Tooltip>
              <span className="freshness-time">
                {overview?.latest ? `${dateTime(overview.latest.ts, true)} · 距今 ${duration(age)}` : '等待采集记录'}
              </span>
            </div>
          </section>
          <ErrorNotice error={monitor.days.error} retry={monitor.days.retry} />
          <ErrorNotice error={monitor.error} retry={monitor.refresh} />
          {overview && historical && (
            <div className="history-notice">
              <Icon name="coverage" size={16} />
              <span>
                正在回看 <strong>{monitor.day}</strong> 的历史记录，可以查看重启前的数据。CPU 卡片仍是当前主机读数。
              </span>
            </div>
          )}
          {overview && !overview.latest && (
            <Alert
              className="empty-sample-alert"
              type="info"
              showIcon
              message="此日期或时间窗口没有有效样本"
              description="可切换采样日期或扩大范围。覆盖状态与异常现场仍可查看。"
            />
          )}
          {!overview ? (
            monitor.loading || monitor.days.loading || (!monitor.days.data && !monitor.days.error) ? (
              <div className="loading-layout">
                <div className="loading-metrics">
                  {[0, 1, 2, 3].map((index) => (
                    <div className="panel" key={index}>
                      <Skeleton active title paragraph={{ rows: 2 }} />
                    </div>
                  ))}
                </div>
                <div className="panel loading-chart">
                  <Skeleton active paragraph={{ rows: 10 }} />
                </div>
              </div>
            ) : (
              <div className="panel full-empty">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={monitor.error || monitor.days.error ? '数据读取失败，请重试' : '还没有可用的采集记录'}
                />
                <p>采集日志可用后，选择日期即可查看真实数据。</p>
                <Button onClick={monitor.refresh} icon={<Icon name="refresh" size={16} />}>
                  重新读取
                </Button>
              </div>
            )
          ) : (
            <>
              {page === 'overview' && (
                <OverviewPage
                  overview={overview}
                  onProcess={setSelectedProcess}
                  onIncident={setSelectedIncident}
                  navigate={navigate}
                />
              )}
              {page === 'processes' && (
                <>
                  <div className="process-summary">
                    <div>
                      <span className="eyebrow">SNAPSHOT</span>
                      <strong>{dateTime(overview.latest?.ts)}</strong>
                    </div>
                    <div>
                      <span className="eyebrow">RECORDED</span>
                      <strong>
                        {overview.latest?.procs.length ?? 0}
                        <small> 个已记录进程</small>
                      </strong>
                    </div>
                    <div>
                      <span className="eyebrow">SYSTEM TOTAL</span>
                      <strong>
                        {number(overview.latest?.agg.seen_count ?? overview.latest?.agg.count, 0)}
                        <small> 个可见 / 可读进程</small>
                      </strong>
                    </div>
                    <div className="process-summary-note">
                      采集器可能只记录部分进程。下表来自最后快照，点击进程查看同一实例的历史。
                    </div>
                  </div>
                  <div className="process-page-grid">
                    <Panel title="进程浏览器" eyebrow="PROCESS SNAPSHOT" extra={<FootprintInfo />}>
                      <ProcessTable
                        processes={overview.latest?.procs || []}
                        onSelect={setSelectedProcess}
                        sampleAt={overview.latest?.ts}
                      />
                    </Panel>
                    <Panel title="应用分组" eyebrow="GROUPED FOOTPRINT">
                      <Groups groups={overview.groups} expanded />
                      <div className="group-note">
                        分组 Footprint 只用于比较，不相加推算物理内存。V2 进程读写速率可在表格中排序。
                      </div>
                    </Panel>
                  </div>
                </>
              )}
              {page === 'incidents' && (
                <>
                  <div className="incident-summary">
                    <span className="incident-summary-symbol">
                      <Icon name="incidents" size={28} />
                    </span>
                    <div>
                      <h2>{overview.incidents.length} 个现场记录</h2>
                      <p>所选日期与范围内的触发记录；每个现场保留独立的系统快照。</p>
                    </div>
                    <Tag>只读证据</Tag>
                  </div>
                  <Panel title="现场记录" eyebrow="CAPTURED EVIDENCE">
                    <IncidentList incidents={overview.incidents} onSelect={setSelectedIncident} />
                    <div className="table-note">
                      健康级别来自采集服务。异常信号用于定位时间窗口，不单独作为根因判断。
                    </div>
                  </Panel>
                </>
              )}
              {page === 'coverage' && <Coverage overview={overview} />}
            </>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-logo">M</span>Mica Performance <span className="footer-divider">/</span>{' '}
              本地性能观察
            </span>
            <span>{overview ? `接口生成于 ${dateTime(overview.generatedAt)} · ` : ''}采样频率由采集器决定</span>
          </footer>
        </main>
      </div>
      <ProcessDrawer process={selectedProcess} day={monitor.day} onClose={() => setSelectedProcess(null)} />
      <IncidentDrawer incident={selectedIncident} onClose={() => setSelectedIncident(null)} />
    </div>
  );
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#64d9e8',
          colorInfo: '#64d9e8',
          colorSuccess: '#a4e6af',
          colorWarning: '#e5bf79',
          colorError: '#ed9697',
          colorBgBase: '#10171d',
          colorBgContainer: '#151e25',
          colorBgElevated: '#1a252d',
          colorBorder: '#2a3943',
          colorText: '#e0e8ed',
          colorTextSecondary: '#8c9eaa',
          borderRadius: 8,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          fontSize: 13,
        },
        components: {
          Table: {
            headerBg: '#18232b',
            rowHoverBg: '#1b2b34',
            borderColor: '#25323a',
            headerColor: '#91a4b0',
            cellPaddingBlockMD: 15,
          },
          Segmented: { trackBg: '#10191f', itemSelectedBg: '#2b3d47', itemSelectedColor: '#d7f3f6' },
          Select: { optionSelectedBg: '#263c45' },
          Drawer: { colorBgElevated: '#131e26' },
          Alert: {
            colorInfoBg: '#102a32',
            colorInfoBorder: '#25454f',
            colorWarningBg: '#30291d',
            colorWarningBorder: '#57472d',
          },
        },
      }}
    >
      <Cockpit />
    </ConfigProvider>
  );
}
