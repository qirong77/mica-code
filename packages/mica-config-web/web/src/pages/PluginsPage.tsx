import { useEffect, useState } from 'react';
import { Alert, Button, DescriptionList, Empty, Tag } from '../components/Ui.js';
import { readPluginsDetails } from '../api.js';
import type { ConfigWebPluginsDetails } from '../../../src/shared/types.js';

export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readPluginsDetails());
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
          <h2>Plugins</h2>
          <p className="path-text">{details?.root ?? ''}</p>
        </div>
        <Button icon="↻" title="重新加载" onClick={load} loading={loading} />
      </header>
      {error ? <Alert message={error} /> : null}
      <div className="detail-body">
        {!details || details.plugins.length === 0 ? (
          <Empty description="暂无文件插件" />
        ) : (
          <div className="detail-list">
            {details.plugins.map((plugin) => (
              <section className="detail-card" key={plugin.file}>
                <div className="detail-card-title">
                  <div className="title-row">
                    <h3>{plugin.name}</h3>
                    <Tag>{plugin.id}</Tag>
                    <Tag tone="blue">{plugin.extension}</Tag>
                    <Tag tone={plugin.status === 'loaded' ? 'green' : plugin.status === 'failed' ? 'red' : 'default'}>
                      {plugin.status ?? 'unknown'}
                    </Tag>
                  </div>
                  <span className="muted-text">{formatBytes(plugin.sizeBytes)}</span>
                </div>
                <DescriptionList
                  items={[
                    { label: 'File', value: plugin.file },
                    { label: 'Updated', value: formatDate(plugin.updatedAt) },
                    { label: 'Error', value: plugin.error },
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
