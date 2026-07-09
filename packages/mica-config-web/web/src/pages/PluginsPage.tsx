import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { readPluginsDetails } from '../api.js';
import type { ConfigWebPlugin, ConfigWebPluginsDetails } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

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
    <PageFrame
      title="Plugins"
      path={details?.root}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div className="detail-body detail-body-stacked">
        {!details || details.plugins.length === 0 ? (
          <Empty description="暂无文件插件" />
        ) : (
          <div className="plugin-grid">
            {details.plugins.map((plugin) => (
              <PluginCard key={plugin.file} plugin={plugin} />
            ))}
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function PluginCard({ plugin }: { plugin: ConfigWebPlugin }) {
  return (
    <section className="simple-card plugin-card">
      <div className="table-panel-title">
        <strong>{plugin.name}</strong>
        <span>{plugin.id}</span>
      </div>
      <div className="table-tags">
        <Tag tone="blue">{plugin.extension}</Tag>
        <Tag tone={plugin.status === 'loaded' ? 'green' : plugin.status === 'failed' ? 'red' : 'default'}>{plugin.status ?? 'unknown'}</Tag>
      </div>
      <div className="simple-list">
        <div className="simple-row">
          <span>File</span>
          <strong>{plugin.file}</strong>
        </div>
        <div className="simple-row">
          <span>Size</span>
          <strong>{formatBytes(plugin.sizeBytes)}</strong>
        </div>
        <div className="simple-row">
          <span>Updated</span>
          <strong>{formatDate(plugin.updatedAt)}</strong>
        </div>
        <div className="simple-row">
          <span>Error</span>
          <strong>{plugin.error || '-'}</strong>
        </div>
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

