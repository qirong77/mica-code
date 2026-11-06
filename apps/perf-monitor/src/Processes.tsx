import { useMemo, useState } from 'react';
import { Button, Descriptions, Drawer, Empty, Input, Skeleton, Table, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ProcessDetail, ProcessRecord } from '../shared/types';
import { ProcessHistoryChart } from './Charts';
import { dateTime, memory, nullableCompare, number, percent } from './format';
import { useJsonResource } from './hooks';
import { ErrorNotice, FootprintInfo, Icon } from './UI';

function ProcessAvatar({ name }: { name: string }) {
  const colors = ['cyan', 'purple', 'green', 'amber'];
  const color = colors[[...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length];
  return (
    <span className={`process-avatar avatar-${color}`}>
      {name
        .replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '')
        .slice(0, 1)
        .toUpperCase() || 'P'}
    </span>
  );
}

export function ProcessTable({
  processes,
  onSelect,
  compact = false,
  sampleAt,
}: {
  processes: ProcessRecord[];
  onSelect: (process: ProcessRecord) => void;
  compact?: boolean;
  sampleAt?: string;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return processes.filter(
      (process) =>
        !value ||
        `${process.n} ${process.pid} ${process.group} ${process.identity}`.toLocaleLowerCase().includes(value),
    );
  }, [processes, search]);
  const columns: TableColumnsType<ProcessRecord> = [
    {
      title: '进程',
      key: 'name',
      fixed: 'left',
      width: 235,
      sorter: (a, b) => a.n.localeCompare(b.n),
      render: (_, record) => (
        <button
          className="process-name-button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(record);
          }}
        >
          <ProcessAvatar name={record.n} />
          <span className="process-label">
            <strong title={record.n}>{record.n}</strong>
            <small>
              PID {record.pid} <span>· {record.group || '未分组'}</span>
            </small>
          </span>
        </button>
      ),
    },
    {
      title: <FootprintInfo />,
      dataIndex: 'fp',
      key: 'fp',
      width: 135,
      defaultSortOrder: 'descend',
      sorter: (a, b) => nullableCompare(a.fp, b.fp),
      render: (value: number) => <span className="numeric strong">{memory(value)}</span>,
    },
    {
      title: (
        <Tooltip title="进程 CPU 使用率按单逻辑核计：100% 约等于占满一个核，多线程进程可超过 100%。缺失值不按 0 处理。">
          CPU <span className="info-circle">i</span>
        </Tooltip>
      ),
      dataIndex: 'cpu',
      key: 'cpu',
      width: 100,
      sorter: (a, b) => nullableCompare(a.cpu, b.cpu),
      render: (value: number | null) => <span className="numeric">{percent(value)}</span>,
    },
    {
      title: '内存变化',
      dataIndex: 'fpd',
      key: 'growth',
      width: 125,
      sorter: (a, b) => nullableCompare(a.fpd, b.fpd),
      render: (value: number) => (
        <span className={`numeric ${value > 0 ? 'text-amber' : value < 0 ? 'text-green' : 'text-muted'}`}>
          {value > 0 ? '+' : ''}
          {memory(value)}
        </span>
      ),
    },
    {
      title: (
        <Tooltip title="V2 采集器提供的进程磁盘写入增量；旧日志及无权读取进程显示为空。不代表具体路径。">
          写入 MB/s
        </Tooltip>
      ),
      key: 'write',
      width: 120,
      sorter: (a, b) => nullableCompare(a.writeMBs, b.writeMBs),
      render: (_, row) => <span className="numeric text-cyan">{number(row.writeMBs, 3)}</span>,
    },
    ...(!compact
      ? [
          {
            title: '读取 MB/s',
            key: 'read',
            width: 120,
            sorter: (a: ProcessRecord, b: ProcessRecord) => nullableCompare(a.readMBs, b.readMBs),
            render: (_: unknown, row: ProcessRecord) => <span className="numeric">{number(row.readMBs, 3)}</span>,
          },
          {
            title: 'RSS',
            dataIndex: 'rss',
            key: 'rss',
            width: 115,
            sorter: (a: ProcessRecord, b: ProcessRecord) => nullableCompare(a.rss, b.rss),
            render: (value: number) => <span className="numeric">{memory(value)}</span>,
          },
          {
            title: '线程',
            dataIndex: 'th',
            key: 'threads',
            width: 85,
            sorter: (a: ProcessRecord, b: ProcessRecord) => nullableCompare(a.th, b.th),
            render: (value: number | null) => <span className="numeric">{number(value, 0)}</span>,
          },
          {
            title: '父 PID',
            dataIndex: 'pp',
            key: 'parent',
            width: 90,
            render: (value: number) => <span className="numeric text-muted">{value}</span>,
          },
        ]
      : []),
    {
      title: '',
      key: 'open',
      width: 42,
      render: () => (
        <span className="row-arrow">
          <Icon name="arrow" size={15} />
        </span>
      ),
    },
  ];
  return (
    <div className="process-table-content">
      <div className="table-toolbar">
        <Input
          allowClear
          prefix={<Icon name="search" size={16} />}
          placeholder="搜索进程、PID 或应用组"
          aria-label="搜索进程、PID 或应用组"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="process-search"
        />
        <span className="table-count">
          {filtered.length} 个已记录进程
          {sampleAt && <span className="sample-label"> · {dateTime(sampleAt, true)}</span>}
        </span>
      </div>
      <Table<ProcessRecord>
        className="process-table"
        columns={columns}
        dataSource={filtered}
        rowKey={(record) => record.identity || `${record.pid}:${record.n}`}
        size="middle"
        scroll={{ x: compact ? 780 : 1200 }}
        pagination={{
          current: Math.min(page, Math.max(1, Math.ceil(filtered.length / (compact ? 6 : 12)))),
          onChange: setPage,
          pageSize: compact ? 6 : 12,
          showSizeChanger: false,
          hideOnSinglePage: true,
          showTotal: (total) => `共 ${total} 个进程`,
        }}
        onRow={(record) => ({ onClick: () => onSelect(record), className: 'clickable-row' })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={search ? '没有匹配的进程' : '此时间段没有进程快照'}
            />
          ),
        }}
      />
    </div>
  );
}

export function ProcessDrawer({
  process,
  day,
  onClose,
}: {
  process: ProcessRecord | null;
  day: string;
  onClose: () => void;
}) {
  const resource = useJsonResource<ProcessDetail>(
    process
      ? `/api/processes/${process.pid}?day=${encodeURIComponent(day)}&identity=${encodeURIComponent(process.identity)}`
      : null,
  );
  const detail = resource.data;
  return (
    <Drawer
      open={!!process}
      onClose={onClose}
      width={740}
      title={
        <div className="drawer-title">
          <span className="eyebrow">PROCESS INSPECTOR</span>
          <span>进程详情</span>
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
          <div className="process-hero">
            <ProcessAvatar name={detail.process.n} />
            <div>
              <h2>{detail.process.n}</h2>
              <div className="tag-line">
                <Tag>PID {detail.process.pid}</Tag>
                <Tag>{detail.process.group || '未分组'}</Tag>
                <span className="text-muted">{day} 的进程实例</span>
              </div>
            </div>
          </div>
          <div className="drawer-stats">
            <div>
              <span>Footprint</span>
              <strong>{memory(detail.process.fp)}</strong>
            </div>
            <div>
              <span>RSS</span>
              <strong>{memory(detail.process.rss)}</strong>
            </div>
            <div>
              <span>CPU / 单核</span>
              <strong>{percent(detail.process.cpu)}</strong>
            </div>
            <div>
              <span>内存变化</span>
              <strong className={detail.process.fpd > 0 ? 'text-amber' : ''}>
                {detail.process.fpd > 0 ? '+' : ''}
                {memory(detail.process.fpd)}
              </strong>
            </div>
          </div>
          <div className="detail-section">
            <div className="detail-section-heading">
              <h3>实例历史</h3>
              <FootprintInfo />
            </div>
            {detail.history.length ? (
              <ProcessHistoryChart history={detail.history} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该进程实例尚无历史样本" />
            )}
            <p className="caption">CPU 100% 约等于占满一个逻辑核，多核并行可超过 100%；未采集的数据保留为空。</p>
          </div>
          <div className="detail-section">
            <h3>进程信息</h3>
            <Descriptions
              column={1}
              size="small"
              colon={false}
              items={[
                {
                  key: 'parent',
                  label: '父进程',
                  children: detail.parent
                    ? `${detail.parent.name} · PID ${detail.parent.pid}`
                    : `PID ${detail.process.pp} · 名称未采集`,
                },
                { key: 'start', label: '首次登记', children: dateTime(detail.start) },
                {
                  key: 'io',
                  label: '磁盘读取 / 写入',
                  children: `${number(detail.process.readMBs, 3)} / ${number(detail.process.writeMBs, 3)} MB/s`,
                },
                {
                  key: 'threads',
                  label: '线程 / 文件描述符',
                  children: `${number(detail.process.th, 0)} / ${number(detail.process.fd, 0)}`,
                },
                {
                  key: 'identity',
                  label: '实例标识',
                  children: <code className="break-word">{detail.process.identity}</code>,
                },
              ]}
            />
            <div className="command-label">完整命令</div>
            <pre className="text-preview command-preview">{detail.command || '该实例的完整命令尚未采集。'}</pre>
          </div>
          {detail.note && (
            <div className="detail-note">
              <Icon name="coverage" size={16} />
              <span>{detail.note}</span>
            </div>
          )}
        </>
      ) : (
        !resource.loading && !resource.error && <Empty description="请选择进程" />
      )}
      {resource.error && detail && <Button onClick={resource.retry}>重新加载详情</Button>}
    </Drawer>
  );
}
