import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, CollapsiblePanel, Empty, Tag } from '../components/Ui.js';
import { readMcpDetails } from '../api.js';
import type { ConfigWebMcpDetails, ConfigWebMcpServer } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

export function McpPage() {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <PageFrame
      title="MCP"
      path={details?.path}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div style={{ marginTop: '4px' }}></div>

      <div className="detail-body detail-body-stacked">
        {!details || details.servers.length === 0 ? (
          <Empty description="暂无 MCP server" />
        ) : (
          <div className="stacked-panels">
            {details.servers.map((server) => (
              <ServerPanel key={server.name} server={server} />
            ))}
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function ServerPanel({ server }: { server: ConfigWebMcpServer }) {
  return (
    <CollapsiblePanel
      title={server.name}
      subtitle={server.target}
      meta={
        <>
          <Tag>{server.type}</Tag>
          <Tag tone={statusColor(server.status)}>{server.status}</Tag>
          <span className="metric-chip">{server.toolCount} tools</span>
        </>
      }
    >
      <div className="simple-list">
        <div className="simple-row">
          <span>Config</span>
          <strong>{server.configPath}</strong>
        </div>
        <div className="simple-row">
          <span>CWD</span>
          <strong>{server.cwd || '-'}</strong>
        </div>
        <div className="simple-row">
          <span>Env</span>
          <strong>{server.envKeys?.join(', ') || '-'}</strong>
        </div>
        <div className="simple-row">
          <span>Error</span>
          <strong>{server.error || '-'}</strong>
        </div>
      </div>

      <div className="tool-list">
        {server.tools.length === 0 ? (
          <p className="muted-text">暂无 tools</p>
        ) : (
          server.tools.map((tool) => (
            <div className="tool-item" key={tool.name}>
              <strong>{tool.name}</strong>
              <p>{tool.description || '无描述'}</p>
            </div>
          ))
        )}
      </div>
    </CollapsiblePanel>
  );
}

function statusColor(status: string): 'default' | 'green' | 'red' | 'blue' {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}
