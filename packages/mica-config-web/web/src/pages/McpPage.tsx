import { useEffect, useState } from 'react';
import { Alert, Button, Collapse, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
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
          <Typography.Title level={4}>MCP</Typography.Title>
          <Typography.Text type="secondary">{details?.path ?? ''}</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
      </header>
      {error ? <Alert className="editor-alert" type="error" message={error} showIcon /> : null}
      <div className="detail-body">
        {!details || details.servers.length === 0 ? (
          <Empty description="暂无 MCP server" />
        ) : (
          <div className="detail-list">
            {details.servers.map((server) => (
              <section className="detail-card" key={server.name}>
                <div className="detail-card-title">
                  <Space>
                    <Typography.Title level={5}>{server.name}</Typography.Title>
                    <Tag>{server.type}</Tag>
                    <Tag color={statusColor(server.status)}>{server.status}</Tag>
                  </Space>
                  <Typography.Text type="secondary">{server.toolCount} tools</Typography.Text>
                </div>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="Target">{server.target}</Descriptions.Item>
                  {server.cwd ? <Descriptions.Item label="CWD">{server.cwd}</Descriptions.Item> : null}
                  {server.envKeys?.length ? <Descriptions.Item label="Env / Headers">{server.envKeys.join(', ')}</Descriptions.Item> : null}
                  {server.error ? <Descriptions.Item label="Error">{server.error}</Descriptions.Item> : null}
                </Descriptions>
                <Collapse
                  className="tools-collapse"
                  size="small"
                  ghost
                  items={[
                    {
                      key: 'tools',
                      label: '工具详情',
                      children:
                        server.tools.length === 0 ? (
                          <Typography.Text type="secondary">暂无已连接工具信息</Typography.Text>
                        ) : (
                          <div className="tool-list">
                            {server.tools.map((tool) => (
                              <div className="tool-item" key={tool.name}>
                                <Typography.Text strong>{tool.name}</Typography.Text>
                                <Typography.Paragraph type="secondary">{tool.description || '无描述'}</Typography.Paragraph>
                              </div>
                            ))}
                          </div>
                        ),
                    },
                  ]}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function statusColor(status: string): string {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}
