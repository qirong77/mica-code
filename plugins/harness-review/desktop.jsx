import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '@arco-design/web-react/es/Card';
import Descriptions from '@arco-design/web-react/es/Descriptions';
import Skeleton from '@arco-design/web-react/es/Skeleton';
import Statistic from '@arco-design/web-react/es/Statistic';
import Tabs from '@arco-design/web-react/es/Tabs';
import { Alert, Button, DataTable, Empty, Input, PageFrame, SelectMenu, Switch, Tag } from '@mica-config-ui/web';
import { createConsoleViewController } from './console-view.js';
import './console.css';

const TAB_OPTIONS = [
  { value: 'overview', label: '总览' },
  { value: 'findings', label: '问题候选' },
  { value: 'runs', label: '运行记录' },
  { value: 'plugins', label: '插件与埋点' },
  { value: 'coverage', label: '系统日志与覆盖' },
];
const TAB_VALUES = new Set(TAB_OPTIONS.map((item) => item.value));

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const count = (value) => n(value).toLocaleString('zh-CN');
const short = (value) => {
  const valueNumber = n(value);
  if (valueNumber >= 1_000_000) return `${(valueNumber / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (valueNumber >= 1_000) return `${(valueNumber / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return count(valueNumber);
};
const date = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' : parsed.toLocaleString('zh-CN', { hour12: false });
};
const duration = (value) => (n(value) > 0 ? `${(n(value) / 1000).toFixed(1)} 秒` : '—');
const text = (value) => (value === undefined || value === null || value === '' ? '—' : String(value));
const sourceLabel = { main: '主运行', delegation: '委派', helper: 'Helper' };
const loadingLabel = { loaded: '已加载', failed: '加载失败', skipped: '已跳过', unknown: '无记录' };
const healthLabel = { ok: '正常上报', warn: '需关注', error: '故障' };
const operationLabel = {
  success: '处理完成',
  error: '失败',
  timeout: '超时',
  cancelled: '已取消',
  declined: '已拒绝',
  waiting: '等待',
  conflict: '冲突',
  busy: '忙',
  partial: '部分结果',
  skipped: '已跳过',
  unknown: '未知',
};
const outcomeLabel = {
  running: '未收尾',
  completed: '已完成',
  error: '错误',
  interrupted: '中断未知',
  aborted: '已取消',
  paused: '已暂停',
};
const findingStatusLabel = {
  open: '待处理',
  accepted: '已接受',
  dismissed: '已忽略',
  validated: '已验证',
  regressed: '回归',
};
const groupLabel = {
  recentRecurring: '近期反复',
  recentSingle: '近期一次',
  historicalPending: '历史待处理',
  timeUnknown: '时间未知',
  acceptedPending: '已接受待验证',
  validatedWatching: '已验证待观察',
  dismissed: '已忽略',
  needsReview: '待复核',
};

function toneFor(value) {
  if (['error', 'failed', 'regressed'].includes(value)) return 'red';
  if (['accepted', 'validated'].includes(value)) return 'blue';
  if (['completed', 'success', 'loaded', 'ok'].includes(value)) return 'green';
  if (['running', 'interrupted', 'aborted', 'paused', 'unknown', 'warn', 'skipped'].includes(value)) return 'amber';
  return 'default';
}

function StateTag({ value, label }) {
  return <Tag tone={toneFor(value)}>{label ?? text(value)}</Tag>;
}

function CountMeta({ total, shown }) {
  return (
    <span className="harness-count-meta">
      显示 {count(shown)} / 总数 {count(total)}
    </span>
  );
}

function SectionCard({ title, total, shown, children, className = '' }) {
  return (
    <Card
      className={`harness-card ${className}`.trim()}
      size="small"
      title={title}
      extra={total === undefined ? undefined : <CountMeta total={total} shown={shown} />}
    >
      {children}
    </Card>
  );
}

function EmptyRows({ message = '未观察到样本' }) {
  return <Empty description={message} />;
}

function SkeletonPage() {
  return (
    <div className="harness-console-skeleton" aria-label="正在加载 Harness 复盘数据">
      <Skeleton animation text={{ rows: 2 }} />
      <Skeleton animation text={{ rows: 6 }} />
    </div>
  );
}

function Overview({ snapshot }) {
  const totals = snapshot.totals;
  const kpis = [
    ['主运行', totals.mainRuns, '不含委派与 Helper'],
    ['模型请求', totals.requests, '所有来源合计'],
    ['工具失败', totals.toolErrors, '只计已归因失败'],
    ['待复核', snapshot.progress.needsReview, '问题候选需重新看'],
  ];
  const sourceRows = [
    { id: 'main', label: '主运行', runs: totals.mainRuns },
    { id: 'delegation', label: '委派', runs: totals.delegatedRuns },
    { id: 'helper', label: 'Helper', runs: totals.helperRuns },
  ];
  const stateRows = [
    ['running', '未收尾'],
    ['completed', '已完成'],
    ['failed', '确认错误'],
    ['interrupted', '中断未知'],
    ['aborted', '已取消'],
    ['paused', '已暂停'],
  ];
  const progressRows = Object.entries(snapshot.progress || {}).map(([id, value]) => ({
    id,
    label: groupLabel[id] ?? id,
    value,
  }));
  return (
    <div className="harness-tab-content">
      <div className="harness-kpis">
        {kpis.map(([label, value, note]) => (
          <Card key={label} className="harness-kpi" size="small">
            <Statistic title={label} value={n(value)} groupSeparator countUp={false} />
            <span className="harness-muted">{note}</span>
          </Card>
        ))}
      </div>
      <div className="harness-two-columns">
        <SectionCard title="按来源">
          <div className="harness-source-grid">
            {sourceRows.map((row) => (
              <div key={row.id}>
                <strong>{count(row.runs)}</strong>
                <span>{row.label}</span>
              </div>
            ))}
          </div>
        </SectionCard>
        <SectionCard title="执行状态（含委派与 Helper）">
          <div className="harness-inline-stats">
            {stateRows.map(([id, label]) => (
              <div key={id}>
                <StateTag value={id} label={label} />
                <strong>{count(totals[id])}</strong>
              </div>
            ))}
          </div>
          <p className="harness-note">未收尾只表示缺少终态记录，不证明宿主仍在运行。</p>
        </SectionCard>
      </div>
      <SectionCard title={`评估进展 · ${count(snapshot.counts.findings)} 项候选`}>
        {progressRows.length ? (
          <div className="harness-progress-grid">
            {progressRows.map((row) => (
              <div key={row.id}>
                <span>{row.label}</span>
                <strong>{count(row.value)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
      <SectionCard title="工具健康" total={snapshot.counts.toolHealth} shown={snapshot.toolHealth.length}>
        <p className="harness-note">
          仅统计完整可归因轨迹：纳入 {count(snapshot.toolHealthCoverage?.includedRuns)} 次，排除{' '}
          {count(snapshot.toolHealthCoverage?.excludedRuns)} 次，未知结果{' '}
          {count(snapshot.toolHealthCoverage?.unknownResults)} 个。
        </p>
        <ToolHealthTable rows={snapshot.toolHealth} />
      </SectionCard>
    </div>
  );
}

function ToolHealthTable({ rows }) {
  if (!rows.length) return <EmptyRows />;
  return (
    <DataTable
      ariaLabel="工具健康"
      columns={[
        { key: 'name', label: '工具', width: '34%' },
        { key: 'calls', label: '调用', align: 'right' },
        { key: 'errors', label: '失败', align: 'right' },
        { key: 'rate', label: '失败率', align: 'right' },
        { key: 'categories', label: '主要类别', narrow: 'secondary' },
      ]}
      rows={rows}
      rowKey={(row) => row.name}
      renderCells={(row) => [
        <span key="name" title={row.name}>
          {row.name}
        </span>,
        count(row.calls),
        count(row.errors),
        `${(n(row.errorRate) * 100).toFixed(1)}%`,
        text((row.categories || []).map((item) => `${item.category} (${count(item.count)})`).join('、')),
      ]}
      emptyText="未观察到工具样本"
    />
  );
}

function Findings({ snapshot }) {
  const [status, setStatus] = useState('all');
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const rows = useMemo(
    () =>
      snapshot.findings.filter((row) => {
        const needle = query.trim().toLowerCase();
        return (
          (status === 'all' || row.status === status) &&
          (group === 'all' || row.group === group) &&
          (!needle || `${row.title} ${row.module} ${row.id}`.toLowerCase().includes(needle))
        );
      }),
    [group, query, snapshot.findings, status],
  );
  const finding = snapshot.findings.find((row) => row.id === selected);
  return (
    <div className="harness-tab-content">
      <Card className="harness-filter-card" size="small">
        <div className="harness-filters">
          <Input value={query} placeholder="搜索标题、模块或 ID" aria-label="搜索问题候选" onChange={setQuery} />
          <SelectMenu
            value={status}
            options={[
              { value: 'all', label: '全部状态' },
              ...Object.entries(findingStatusLabel).map(([value, label]) => ({ value, label })),
            ]}
            ariaLabel="问题状态"
            onChange={setStatus}
          />
          <SelectMenu
            value={group}
            options={[
              { value: 'all', label: '全部分组' },
              ...Object.entries(groupLabel).map(([value, label]) => ({ value, label })),
            ]}
            ariaLabel="问题分组"
            onChange={setGroup}
          />
        </div>
        <p className="harness-note">筛选仅作用于当前有界投影，候选不等于已确认缺陷。</p>
      </Card>
      <SectionCard title="问题候选" total={snapshot.counts.findings} shown={rows.length}>
        {rows.length ? (
          <DataTable
            ariaLabel="问题候选"
            columns={[
              { key: 'title', label: '名称', width: '34%' },
              { key: 'status', label: '状态' },
              { key: 'group', label: '分组' },
              { key: 'count', label: '出现', align: 'right' },
              { key: 'module', label: '模块', narrow: 'secondary' },
              { key: 'action', label: '详情', align: 'right' },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            renderCells={(row) => [
              <Button
                key="title"
                variant="ghost"
                size="compact"
                className="harness-name-button"
                title={`查看 ${row.title}`}
                onClick={() => setSelected(row.id)}
              >
                {row.title}
              </Button>,
              <StateTag key="status" value={row.status} label={findingStatusLabel[row.status] ?? row.status} />,
              <Tag key="group">{groupLabel[row.group] ?? row.group}</Tag>,
              count(row.occurrences),
              text(row.module),
              <Button key="detail" variant="ghost" size="compact" onClick={() => setSelected(row.id)}>
                查看
              </Button>,
            ]}
            emptyText="未观察到问题候选"
          />
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
      {finding ? <FindingDetail finding={finding} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function FindingDetail({ finding, onClose }) {
  return (
    <Card
      className="harness-detail-card"
      size="small"
      title="问题候选详情"
      extra={
        <Button variant="ghost" size="compact" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <Descriptions
        column={2}
        size="small"
        data={[
          { label: '名称', value: finding.title },
          {
            label: '状态',
            value: <StateTag value={finding.status} label={findingStatusLabel[finding.status] ?? finding.status} />,
          },
          { label: '模块', value: text(finding.module) },
          { label: '工作区', value: text(finding.cwd) },
          { label: '首次出现', value: date(finding.firstSeenAt) },
          { label: '最近出现', value: date(finding.lastSeenAt) },
          { label: '证据条数', value: count(finding.evidenceCount) },
          { label: '候选 ID', value: finding.id },
        ]}
      />
      <div className="harness-detail-copy">
        <strong>建议</strong>
        <p>{text(finding.suggestion)}</p>
        <strong>验证进展</strong>
        <p>{text(finding.evaluation)}</p>
        {finding.note ? (
          <>
            <strong>备注</strong>
            <p>{finding.note}</p>
          </>
        ) : null}
      </div>
      <div className="harness-evidence-list">
        <strong>证据元数据</strong>
        {(finding.evidence || []).length ? (
          finding.evidence.map((item) => (
            <span key={`${item.runId}-${item.seq}`}>
              {item.runId} · seq {item.seq} · {item.available ? '可用' : '不可用'}
            </span>
          ))
        ) : (
          <span>未观察到证据元数据</span>
        )}
      </div>
    </Card>
  );
}

function Runs({ snapshot }) {
  const rows = snapshot.runs;
  return (
    <div className="harness-tab-content">
      <SectionCard title="运行记录" total={snapshot.counts.runs} shown={rows.length}>
        <p className="harness-note">这些是执行尝试，不是用户会话数；未收尾与中断均不能据此判定任务成功或失败。</p>
        {rows.length ? (
          <DataTable
            ariaLabel="运行记录"
            pageSize={12}
            columns={[
              { key: 'run', label: '运行', width: '28%' },
              { key: 'source', label: '来源' },
              { key: 'provider', label: '供应商 / 模型', width: '24%', narrow: 'secondary' },
              { key: 'outcome', label: '终态' },
              { key: 'requests', label: '请求', align: 'right' },
              { key: 'tools', label: '工具', align: 'right' },
              { key: 'elapsed', label: '耗时', align: 'right' },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            renderCells={(row) => [
              <span key="run" className="harness-cell-stack" title={row.cwd}>
                <strong>{row.sessionTitle || row.id}</strong>
                <small>{date(row.startedAt)}</small>
              </span>,
              <span key="source" className="harness-cell-stack">
                <Tag>{sourceLabel[row.source] ?? row.source}</Tag>
                {row.source !== 'main' && <small>{row.sourceLabel}</small>}
              </span>,
              <span key="provider" title={`${row.providerId} / ${row.model}`}>
                {text(row.providerId)} / {text(row.model)}
              </span>,
              <StateTag key="outcome" value={row.outcome} label={outcomeLabel[row.outcome] ?? row.outcome} />,
              count(row.requestCount),
              `${count(row.toolCalls)} / ${count(row.toolErrors)}`,
              duration(row.elapsedMs),
            ]}
            emptyText="未观察到运行记录"
          />
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
    </div>
  );
}

function Plugins({ snapshot }) {
  const rows = snapshot.plugins;
  const failures = snapshot.pluginFailures || [];
  return (
    <div className="harness-tab-content">
      <SectionCard title="插件与埋点" total={snapshot.counts.plugins} shown={rows.length}>
        <p className="harness-note">
          装配仅为最近宿主的共享快照；健康为版本匹配的上次上报；操作与曝光来自有界机器日志，不代表所有活进程或完整历史。
        </p>
        <p className="harness-note">
          装配宿主：{text(snapshot.assembly?.host)} · {date(snapshot.assembly?.updatedAt)}
          {snapshot.assembly?.unreadable ? ' · 快照不可读' : ''}
        </p>
        {rows.length ? (
          <DataTable
            ariaLabel="插件与埋点"
            columns={[
              { key: 'plugin', label: '插件', width: '25%' },
              { key: 'loading', label: '最近装配' },
              { key: 'health', label: '最近健康' },
              { key: 'operation', label: '操作 开始 / 结束 / 失败', align: 'right' },
              { key: 'experience', label: '曝光 / 点击', align: 'right' },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            renderCells={(row) => [
              <span key="plugin" className="harness-cell-stack">
                <strong>{row.name}</strong>
                <small>
                  {row.id}
                  {row.version ? ` · ${row.version}` : ''}
                </small>
                {!row.enabled && <Tag>已停用</Tag>}
              </span>,
              <StateTag key="loading" value={row.loading} label={loadingLabel[row.loading] ?? row.loading} />,
              row.health ? (
                <span key="health" className="harness-cell-stack" title={row.health.message}>
                  <StateTag value={row.health.level} label={healthLabel[row.health.level]} />
                  <small>{row.health.message}</small>
                  <small>{date(row.health.at)}</small>
                </span>
              ) : (
                <Tag key="health">未观察到</Tag>
              ),
              row.operationStarts || row.operationFinishes
                ? `${count(row.operationStarts)} / ${count(row.operationFinishes)} / ${count(row.operationErrors)}`
                : '未观察到',
              row.impressions || row.clicks ? `${count(row.impressions)} / ${count(row.clicks)}` : '未观察到',
            ]}
            emptyText="未观察到插件样本"
          />
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
      <SectionCard title="插件后台失败（次数下界）" total={snapshot.counts.pluginFailures} shown={failures.length}>
        {failures.length ? (
          <DataTable
            ariaLabel="插件后台失败"
            columns={[
              { key: 'plugin', label: '插件', width: '28%' },
              { key: 'task', label: '任务' },
              { key: 'count', label: '次数下界', align: 'right' },
              { key: 'last', label: '最近发生', align: 'right' },
            ]}
            rows={failures}
            rowKey={(row) => `${row.pluginId}-${row.taskId}`}
            renderCells={(row) => [text(row.pluginId), text(row.taskId), count(row.count), date(row.lastAt)]}
          />
        ) : (
          <EmptyRows message="未观察到插件后台失败" />
        )}
      </SectionCard>
      <OperationTables logs={snapshot.logEvidence} />
    </div>
  );
}

function OperationTables({ logs }) {
  const operations = logs?.operations ?? [];
  const experience = logs?.experience ?? [];
  return (
    <>
      <SectionCard title="操作日志（机器级有界样本）" total={operations.length} shown={operations.length}>
        {operations.length ? (
          <DataTable
            ariaLabel="插件操作日志"
            pageSize={10}
            columns={[
              { key: 'plugin', label: '插件' },
              { key: 'operation', label: '操作', width: '24%' },
              { key: 'surface', label: '界面', narrow: 'secondary' },
              { key: 'outcome', label: '终态' },
              { key: 'counts', label: '开始 / 结束', align: 'right' },
              { key: 'max', label: '最长耗时', align: 'right' },
            ]}
            rows={operations}
            rowKey={(row) =>
              [row.plugin, row.pluginVersion, row.operation, row.surface, row.outcome, row.code].join(':')
            }
            renderCells={(row) => [
              text(row.plugin),
              text(row.operation),
              text(row.surface),
              <StateTag key="outcome" value={row.outcome} label={operationLabel[row.outcome] ?? row.outcome} />,
              `${count(row.starts)} / ${count(row.finishes)}`,
              duration(row.maxMs),
            ]}
          />
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
      <SectionCard title="界面埋点（机器级有界样本）" total={experience.length} shown={experience.length}>
        {experience.length ? (
          <DataTable
            ariaLabel="插件界面埋点"
            pageSize={10}
            columns={[
              { key: 'plugin', label: '插件' },
              { key: 'event', label: '事件' },
              { key: 'surface', label: '界面' },
              { key: 'action', label: '动作', narrow: 'secondary' },
              { key: 'count', label: '次数', align: 'right' },
            ]}
            rows={experience}
            rowKey={(row) => [row.plugin, row.pluginVersion, row.event, row.surface, row.action, row.outcome].join(':')}
            renderCells={(row) => [
              text(row.plugin),
              text(row.event),
              text(row.surface),
              text(row.action),
              count(row.count),
            ]}
          />
        ) : (
          <EmptyRows />
        )}
      </SectionCard>
    </>
  );
}

function CoverageMetric({ label, value, hint }) {
  return (
    <div className="harness-coverage-metric">
      <strong>{text(value)}</strong>
      <span>{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Coverage({ snapshot }) {
  const coverage = snapshot.coverage || {};
  const logs = snapshot.logEvidence;
  const warnings = snapshot.warnings || [];
  const systemRows = logs?.system || [];
  const memoryRows = logs?.memory || [];
  return (
    <div className="harness-tab-content">
      <SectionCard title="覆盖与截断">
        <div className="harness-coverage-grid">
          <CoverageMetric
            label="运行目录"
            value={`${count(coverage.scannedRunDirectories)} / ${count(coverage.totalRunDirectories)}`}
            hint="扫描 / 总数"
          />
          <CoverageMetric label="纳入运行" value={count(coverage.includedRuns)} />
          <CoverageMetric label="不可读摘要" value={count(coverage.unreadableSummaries)} />
          <CoverageMetric label="规则版本" value={snapshot.classifierVersion} />
          <CoverageMetric
            label="自动采集"
            value={snapshot.recording?.enabled ? '已开启' : '已关闭'}
            hint={snapshot.recording?.captureContent ? '包含脱敏内容' : '仅元数据'}
          />
          <CoverageMetric label="采集丢弃事件" value={count(snapshot.totals.droppedEvents)} />
          <CoverageMetric
            label="工具健康覆盖"
            value={`${count(snapshot.toolHealthCoverage?.includedRuns)} / ${count(snapshot.toolHealthCoverage?.excludedRuns)} / ${count(snapshot.toolHealthCoverage?.unknownResults)}`}
            hint="纳入 / 排除 / 未知"
          />
          <CoverageMetric
            label="推导覆盖"
            value={`${count(snapshot.derivationCoverage?.limitedRuns)} / ${count(snapshot.derivationCoverage?.unknownRuns)}`}
            hint="受限 / 未知运行"
          />
          <CoverageMetric
            label="未跟踪调用观察"
            value={count(snapshot.derivationCoverage?.callObservationsNotTracked)}
          />
          <CoverageMetric
            label="未记录问题信号"
            value={count(snapshot.derivationCoverage?.findingSignalsNotRecorded)}
          />
          <CoverageMetric
            label="机器日志文件"
            value={logs ? `${count(logs.coverage.scannedFiles)} / ${count(logs.coverage.candidateFiles)}` : '未知'}
            hint="扫描 / 候选"
          />
          <CoverageMetric
            label="未纳入 / 不可读日志"
            value={logs ? `${count(logs.coverage.omittedFiles)} / ${count(logs.coverage.unreadableFiles)}` : '未知'}
          />
          <CoverageMetric
            label="坏行 / 丢弃半行"
            value={logs ? `${count(logs.coverage.malformedLines)} / ${count(logs.coverage.partialLines)}` : '未知'}
          />
          <CoverageMetric label="日志检查字节" value={logs ? short(logs.coverage.inspectedBytes) : '未知'} />
          <CoverageMetric label="日志截断文件" value={logs ? count(logs.coverage.truncatedFiles) : '未知'} />
        </div>
        <div className="harness-flag-list">
          {[
            ['运行扫描截断', coverage.scanLimitReached || coverage.runLimitReached],
            ['运行目录不可读', coverage.directoryReadFailed || coverage.unreadableSummaries > 0],
            ['日志行数截断', logs?.coverage?.rowLimitReached],
            ['日志组数截断', logs?.coverage?.groupLimitReached],
            ['装配快照不可读', snapshot.assembly?.unreadable],
          ].map(([label, flagged]) => (
            <Tag key={label} tone={flagged === undefined ? 'default' : flagged ? 'amber' : 'green'}>
              {label}：{flagged === undefined ? '未知' : flagged ? '是' : '否'}
            </Tag>
          ))}
        </div>
        <p className="harness-note">
          近期问题窗口：{date(coverage.windowStart)} — {date(coverage.windowEnd)}。运行采样范围：
          {date(coverage.earliestRunStartedAt)} — {date(coverage.latestRunFinishedAt)}。
        </p>
        <p className="harness-note">
          日志投影范围：{date(logs?.coverage?.earliestAt)} — {date(logs?.coverage?.latestAt)}。上限：
          {count(snapshot.limits?.runs)} 次运行、每次 {count(snapshot.limits?.findingsPerRun)} 项候选 /{' '}
          {count(snapshot.limits?.distinctCallKeysPerRun)} 种调用键，每项最多{' '}
          {count(snapshot.limits?.evidencePerFinding)} 条证据。
        </p>
      </SectionCard>
      <SectionCard title="警告" total={snapshot.counts.warnings} shown={warnings.length}>
        {warnings.length ? (
          <ul className="harness-warning-list">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        ) : (
          <EmptyRows message="未观察到警告" />
        )}
      </SectionCard>
      <div className="harness-two-columns">
        <SectionCard title="系统 warn / error" total={systemRows.length} shown={systemRows.length}>
          {systemRows.length ? (
            <DataTable
              ariaLabel="系统日志"
              columns={[
                { key: 'scope', label: '范围' },
                { key: 'event', label: '事件' },
                { key: 'level', label: '级别' },
                { key: 'count', label: '次数', align: 'right' },
                { key: 'crashes', label: '崩溃', align: 'right' },
              ]}
              rows={systemRows}
              rowKey={(row, index) => `${row.scope}-${row.event}-${index}`}
              renderCells={(row) => [
                text(row.scope),
                text(row.event),
                <StateTag key="level" value={row.level} label={row.level} />,
                count(row.count),
                count(row.crashes),
              ]}
            />
          ) : (
            <EmptyRows message="未观察到系统日志样本" />
          )}
        </SectionCard>
        <SectionCard title="RSS 峰值" total={memoryRows.length} shown={memoryRows.length}>
          {memoryRows.length ? (
            <DataTable
              ariaLabel="RSS 峰值"
              columns={[
                { key: 'pid', label: 'PID' },
                { key: 'samples', label: '采样', align: 'right' },
                { key: 'rss', label: 'RSS MB', align: 'right' },
                { key: 'heap', label: 'Heap MB', align: 'right' },
              ]}
              rows={memoryRows}
              rowKey={(row, index) => `${row.pid ?? 'unknown'}-${index}`}
              renderCells={(row) => [
                text(row.pid),
                count(row.samples),
                n(row.peakRssMB).toFixed(1),
                row.peakHeapMB === undefined ? '—' : n(row.peakHeapMB).toFixed(1),
              ]}
            />
          ) : (
            <EmptyRows message="未观察到内存样本" />
          )}
        </SectionCard>
      </div>
      <p className="harness-note">
        机器日志是全机范围的旁证，不会冒充项目运行根因。completed、operation success
        也不等于验收；零样本表示未观察到，不表示健康。
      </p>
    </div>
  );
}

function readTab(api) {
  const value = api?.page?.search?.()?.tab;
  return TAB_VALUES.has(value) ? value : 'overview';
}

export default function HarnessConsolePage({ api }) {
  const [tab, setTab] = useState(() => readTab(api));
  const [autoRefresh, setAutoRefresh] = useState(true);
  const controller = useMemo(
    () =>
      createConsoleViewController({
        read: (signal) => api?.web?.read('snapshot', {}, { signal }),
      }),
    [api],
  );
  const [view, setView] = useState(controller.getState);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setView);
    const unmount = controller.mount();
    return () => {
      unsubscribe();
      unmount();
      controller.dispose();
    };
  }, [controller]);
  const onTab = useCallback(
    (next) => {
      if (!TAB_VALUES.has(next)) return;
      setTab(next);
      api?.page?.setSearch?.({ tab: next });
    },
    [api],
  );
  const refresh = useCallback(() => {
    void controller.refresh().catch(() => {});
  }, [controller]);
  const setRefresh = useCallback(
    (enabled) => {
      setAutoRefresh(enabled);
      controller.setAutoRefresh?.(enabled);
    },
    [controller],
  );
  const snapshot = view.snapshot;
  const actions = (
    <div className="harness-page-actions">
      <span className="harness-generated-at">统计至 {date(snapshot?.generatedAt)}</span>
      <Button variant="ghost" size="compact" loading={view.refreshing} onClick={refresh}>
        刷新
      </Button>
      <span className="harness-muted">自动刷新</span>
      <Switch checked={autoRefresh} label="自动刷新（聚焦时）" onChange={setRefresh} />
    </div>
  );
  return (
    <div className="mica-config-ui harness-console-shell">
      <PageFrame title="Harness 运行控制台" description="所有工作区 · 只读统计，运行完成不等于验收。" actions={actions}>
        {view.error ? (
          <div className="harness-inline-error">
            <Alert message={`刷新失败：${view.error}。${snapshot ? '已保留上次数据' : '尚无可用快照'}。`} />
          </div>
        ) : null}
        {!snapshot && view.loading ? (
          <SkeletonPage />
        ) : snapshot ? (
          <>
            <Tabs activeTab={tab} onChange={onTab} className="harness-tabs" lazyload={false} justify animation={false}>
              <Tabs.TabPane key="overview" title="总览">
                <Overview snapshot={snapshot} />
              </Tabs.TabPane>
              <Tabs.TabPane key="findings" title="问题候选">
                <Findings snapshot={snapshot} />
              </Tabs.TabPane>
              <Tabs.TabPane key="runs" title="运行记录">
                <Runs snapshot={snapshot} />
              </Tabs.TabPane>
              <Tabs.TabPane key="plugins" title="插件与埋点">
                <Plugins snapshot={snapshot} />
              </Tabs.TabPane>
              <Tabs.TabPane key="coverage" title="系统日志与覆盖">
                <Coverage snapshot={snapshot} />
              </Tabs.TabPane>
            </Tabs>
          </>
        ) : (
          <EmptyRows message="暂无 Harness 快照" />
        )}
      </PageFrame>
    </div>
  );
}

export {
  TAB_OPTIONS,
  EmptyRows,
  Overview,
  Coverage,
  FindingDetail,
  Plugins,
  date as formatDate,
  findingStatusLabel,
  groupLabel,
};
