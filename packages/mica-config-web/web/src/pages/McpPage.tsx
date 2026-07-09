import { useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, DataTable, Empty, SegmentTabs, Tag } from '../components/Ui.js';
import { sectionDescriptions, sectionEyebrows } from '../dashboardData.js';
import { readMcpDetails } from '../api.js';
import type { ConfigWebMcpDetails, ConfigWebMcpServer } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

type McpView = 'servers' | 'tools';

export function McpPage() {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<McpView>('servers');
  const RefreshIcon = appIcons.refresh;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readMcpDetails());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const toolRows = useMemo(() => {
    if (!details) return [];
    return details.servers.flatMap((server) =>
      server.tools.map((tool) => [
        <div className="table-primary" key={`${server.name}-${tool.name}`}>
          <strong>{tool.name}</strong>
          <span>{server.name}</span>
        </div>,
        <Tag>{server.type}</Tag>,
        <span className="table-wrap-text">{tool.description || '无描述'}</span>,
      ]),
    );
  }, [details]);

  return (
    <PageFrame
      eyebrow={sectionEyebrows.mcp}
      title="MCP"
      description={sectionDescriptions.mcp}
      path={details?.path}
      meta={loading ? 'Refreshing' : 'Observed'}
      stats={[
        { label: 'Servers', value: String(details?.servers.length ?? 0), meta: '配置总数' },
        { label: 'Connected', value: String(details?.servers.filter((server) => server.status === 'connected').length ?? 0), meta: '已连通' },
        { label: 'Tools', value: String(details?.servers.reduce((total, server) => total + server.toolCount, 0) ?? 0), meta: '可用工具' },
      ]}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div className="detail-body detail-body-stacked">
        <div className="section-toolbar">
          <SegmentTabs
            items={[
              { key: 'servers', label: 'Servers', count: details?.servers.length ?? 0 },
              { key: 'tools', label: 'Tools', count: details?.servers.reduce((total, server) => total + server.tools.length, 0) ?? 0 },
            ]}
            value={view}
            onChange={(next) => setView(next as McpView)}
          />
        </div>

        {!details || details.servers.length === 0 ? (
          <Empty description="暂无 MCP server" />
        ) : view === 'servers' ? (
          <div className="stacked-panels">
            {details.servers.map((server) => (
              <ServerPanel key={server.name} server={server} />
            ))}
          </div>
        ) : (
          <DataTable columns={['Tool', 'Type', 'Description']} rows={toolRows} emptyMessage="暂无已连接工具信息" />
        )}
      </div>
    </PageFrame>
  );
}

function ServerPanel({ server }: { server: ConfigWebMcpServer }) {
  return (
    <section className="table-panel">
      <header className="table-panel-header">
        <div className="table-panel-title">
          <strong>{server.name}</strong>
          <span>{server.target}</span>
        </div>
        <div className="table-panel-tags">
          <Tag>{server.type}</Tag>
          <Tag tone={statusColor(server.status)}>{server.status}</Tag>
          <span className="metric-chip">{server.toolCount} tools</span>
        </div>
      </header>

      <DataTable
        columns={['Target', 'CWD', 'Env / Headers', 'Error']}
        rows={[
          [
            <span className="table-wrap-text" key="target">{server.target}</span>,
            <span className="table-wrap-text" key="cwd">{server.cwd || '-'}</span>,
            <span className="table-wrap-text" key="env">{server.envKeys?.join(', ') || '-'}</span>,
            <span className="table-wrap-text" key="error">{server.error || '-'}</span>,
          ],
        ]}
      />
    </section>
  );
}

function statusColor(status: string): 'default' | 'green' | 'red' | 'blue' {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}

