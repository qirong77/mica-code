import { useState } from 'react';
import { Alert, Button, Drawer, Empty, Skeleton, Table, Tabs, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ArtifactContent, IncidentDetail, IncidentSummary, ProcessRecord } from '../shared/types';
import { bytes, dateTime, memory, number, percent } from './format';
import { useJsonResource } from './hooks';
import { ErrorNotice, HealthBadge, Icon } from './UI';

export function IncidentList({
  incidents,
  onSelect,
  compact = false,
}: {
  incidents: IncidentSummary[];
  onSelect: (incident: IncidentSummary) => void;
  compact?: boolean;
}) {
  const [page, setPage] = useState(1);
  if (compact)
    return (
      <div className="incident-list">
        {incidents.length ? (
          incidents.slice(0, 4).map((incident) => (
            <button key={incident.id} className="incident-item" onClick={() => onSelect(incident)}>
              <span className={`incident-icon incident-${incident.health}`}>
                <Icon name="incidents" size={16} />
              </span>
              <span className="incident-copy">
                <strong>{incident.reason}</strong>
                <small>
                  {dateTime(incident.ts)} <span>· {incident.artifactCount} 个附件</span>
                </small>
              </span>
              <Icon name="arrow" size={15} />
            </button>
          ))
        ) : (
          <div className="quiet-state">
            <span className="quiet-check">✓</span>
            <strong>没有记录到异常现场</strong>
            <p>触发采集后，现场快照与附件会显示在这里。</p>
          </div>
        )}
      </div>
    );
  const columns: TableColumnsType<IncidentSummary> = [
    {
      title: '记录时间',
      dataIndex: 'ts',
      width: 170,
      sorter: (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
      defaultSortOrder: 'descend',
      render: (value: string) => <span className="numeric">{dateTime(value)}</span>,
    },
    {
      title: '触发信号',
      dataIndex: 'reason',
      width: 300,
      render: (value: string, record) => (
        <button className="text-button incident-reason" onClick={() => onSelect(record)}>
          {value}
        </button>
      ),
    },
    {
      title: '级别',
      dataIndex: 'health',
      width: 140,
      render: (value: IncidentSummary['health']) => <HealthBadge health={value} />,
    },
    { title: '现场附件', dataIndex: 'artifactCount', width: 110, render: (value: number) => `${value} 个` },
    {
      title: '文件写入追踪',
      dataIndex: 'hasFileTrace',
      width: 145,
      render: (value: boolean) => <Tag color={value ? 'cyan' : undefined}>{value ? '已采集' : '未采集'}</Tag>,
    },
    {
      title: '',
      width: 45,
      render: (_, record) => (
        <Button
          type="text"
          aria-label={`查看 ${record.reason}`}
          icon={<Icon name="arrow" size={16} />}
          onClick={() => onSelect(record)}
        />
      ),
    },
  ];
  return (
    <Table<IncidentSummary>
      columns={columns}
      dataSource={incidents}
      rowKey="id"
      scroll={{ x: 920 }}
      size="middle"
      pagination={{
        current: Math.min(page, Math.max(1, Math.ceil(incidents.length / 12))),
        onChange: setPage,
        pageSize: 12,
        showSizeChanger: false,
        hideOnSinglePage: true,
      }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该时间段没有异常现场记录" /> }}
    />
  );
}

function IncidentRanking({
  processes,
  field,
}: {
  processes: ProcessRecord[];
  field: 'fp' | 'fpd' | 'cpu' | 'writeMBs';
}) {
  return (
    <div className="incident-ranking">
      {processes.slice(0, 12).map((process, index) => (
        <div className="mini-process" key={process.identity || `${process.pid}:${process.n}`}>
          <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="mini-process-name">
            <strong title={process.n}>{process.n}</strong>
            <small>PID {process.pid}</small>
          </span>
          <span className={`numeric ${field === 'fpd' && process.fpd > 0 ? 'text-amber' : ''}`}>
            {field === 'cpu'
              ? percent(process.cpu)
              : field === 'writeMBs'
                ? `${number(process.writeMBs, 3)} MB/s`
                : `${field === 'fpd' && process.fpd > 0 ? '+' : ''}${memory(process[field])}`}
          </span>
        </div>
      ))}
      {!processes.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无进程数据" />}
    </div>
  );
}

export function IncidentDrawer({ incident, onClose }: { incident: IncidentSummary | null; onClose: () => void }) {
  const resource = useJsonResource<IncidentDetail>(
    incident ? `/api/incidents/${encodeURIComponent(incident.id)}` : null,
  );
  const [selection, setSelection] = useState<{ incident: string; name: string } | null>(null);
  const artifactName = selection?.incident === incident?.id ? selection?.name : null;
  const artifact = useJsonResource<ArtifactContent>(
    incident && artifactName
      ? `/api/incidents/${encodeURIComponent(incident.id)}/artifacts/${encodeURIComponent(artifactName)}`
      : null,
  );
  const detail = resource.data;
  const text = artifact.data?.content.slice(0, 100_000);
  return (
    <Drawer
      open={!!incident}
      onClose={onClose}
      width={790}
      title={
        <div className="drawer-title">
          <span className="eyebrow">INCIDENT INSPECTOR</span>
          <span>异常现场</span>
        </div>
      }
      rootClassName="monitor-app monitor-drawer"
      closeIcon={<Icon name="close" />}
    >
      <ErrorNotice error={resource.error} retry={resource.retry} />
      {resource.loading && !detail ? (
        <Skeleton active paragraph={{ rows: 12 }} />
      ) : detail ? (
        <>
          <div className="incident-hero">
            <div className="section-meta">
              <HealthBadge health={detail.health} />
              <span>{dateTime(detail.ts)}</span>
            </div>
            <h2>{detail.reason}</h2>
            <p>这是触发时刻的证据快照。信号与写入记录本身不构成根因结论。</p>
          </div>
          <div className="drawer-stats">
            <div>
              <span>Swap 已用</span>
              <strong>{memory(detail.system.swap_used_mb)}</strong>
            </div>
            <div>
              <span>内存压力读数</span>
              <strong>{number(detail.system.pressure, 0)}</strong>
            </div>
            <div>
              <span>磁盘空闲</span>
              <strong>{detail.system.disk_free_gb == null ? '—' : `${number(detail.system.disk_free_gb)} GB`}</strong>
            </div>
            <div>
              <span>1 分钟负载</span>
              <strong>{number(detail.system.load[0], 2)}</strong>
            </div>
          </div>
          <div className="detail-section">
            <h3>现场进程</h3>
            <Tabs
              size="small"
              items={[
                {
                  key: 'growth',
                  label: '内存增长',
                  children: <IncidentRanking processes={detail.topGrowth} field="fpd" />,
                },
                {
                  key: 'memory',
                  label: '内存占用',
                  children: <IncidentRanking processes={detail.topMemory} field="fp" />,
                },
                {
                  key: 'cpu',
                  label: 'CPU / 单核',
                  children: <IncidentRanking processes={detail.topCpu} field="cpu" />,
                },
                {
                  key: 'write',
                  label: '磁盘写入',
                  children: <IncidentRanking processes={detail.topWrite ?? []} field="writeMBs" />,
                },
              ]}
            />
          </div>
          <div className="detail-section">
            <div className="detail-section-heading">
              <h3>现场附件</h3>
              <span className="caption">{detail.artifacts.length} 个文件 · 点击预览</span>
            </div>
            {!detail.hasFileTrace && (
              <Alert
                className="artifact-notice"
                type="info"
                showIcon
                message="此现场未包含文件写入追踪"
                description="root 写盘抓取未安装或未在本次现场运行时，不提供文件级写入归因。"
              />
            )}
            {detail.artifacts.length ? (
              <div className="artifact-list">
                {detail.artifacts.map((item) => (
                  <button
                    key={item.name}
                    className={`artifact-item ${artifactName === item.name ? 'selected' : ''}`}
                    onClick={() => setSelection({ incident: detail.id, name: item.name })}
                  >
                    <span className="artifact-file-icon">≡</span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.kind} · {bytes(item.size)}
                      </small>
                    </span>
                    <Icon name="arrow" size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可用附件" />
            )}
            {artifactName && (
              <div className="artifact-preview">
                <div className="detail-section-heading">
                  <h4>{artifactName}</h4>
                  <span className="caption">纯文本预览</span>
                </div>
                <ErrorNotice error={artifact.error} retry={artifact.retry} />
                {artifact.loading ? (
                  <Skeleton active paragraph={{ rows: 4 }} />
                ) : artifact.data ? (
                  <>
                    <pre className="text-preview">{text || '文件内容为空。'}</pre>
                    {(artifact.data.truncated || artifact.data.content.length > 100_000) && (
                      <p className="text-amber caption">
                        内容已截断；预览最多显示 100,000 个字符。原文件 {bytes(artifact.data.size)}。
                      </p>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
          <div className="detail-section">
            <h3>进程树</h3>
            <pre className="text-preview process-tree">
              {detail.processTree ? detail.processTree.slice(0, 50_000) : '此次现场没有进程树。'}
            </pre>
            {detail.processTree.length > 50_000 && <p className="caption text-amber">进程树预览已截断。</p>}
          </div>
        </>
      ) : null}
    </Drawer>
  );
}
