import { useEffect, useState } from 'react';
import { Alert, Button, DescriptionList, Empty, Tag } from '../components/Ui.js';
import { readMcpDetails } from '../api.js';
import type { ConfigWebMcpDetails } from '../../../src/shared/types.js';

export function McpPage() {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <section className="detail-page">
      <header className="editor-header">
        <div>
          <h2>MCP</h2>
          <p className="path-text">{details?.path ?? ''}</p>
        </div>
        <Button icon="↻" title="重新加载" onClick={load} loading={loading} />
      </header>
      {error ? <Alert message={error} /> : null}
      <div className="detail-body">
        {!details || details.servers.length === 0 ? (
          <Empty description="暂无 MCP server" />
        ) : (
          <div className="detail-list">
            {details.servers.map((server) => (
              <section className="detail-card" key={server.name}>
                <div className="detail-card-title">
                  <div className="title-row">
                    <h3>{server.name}</h3>
                    <Tag>{server.type}</Tag>
                    <Tag tone={statusColor(server.status)}>{server.status}</Tag>
                  </div>
                  <span className="muted-text">{server.toolCount} tools</span>
                </div>
                <DescriptionList
                  items={[
                    { label: 'Target', value: server.target },
                    { label: 'CWD', value: server.cwd },
                    { label: 'Env / Headers', value: server.envKeys?.join(', ') },
                    { label: 'Error', value: server.error },
                  ]}
                />
                <details className="tools-collapse">
                  <summary>工具详情</summary>
                  {server.tools.length === 0 ? (
                    <p className="muted-text">暂无已连接工具信息</p>
                  ) : (
                    <div className="tool-list">
                      {server.tools.map((tool) => (
                        <div className="tool-item" key={tool.name}>
                          <strong>{tool.name}</strong>
                          <p>{tool.description || '无描述'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function statusColor(status: string): 'default' | 'green' | 'red' | 'blue' {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}
