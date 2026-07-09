import { useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, DataTable, Empty, SegmentTabs, Tag } from '../components/Ui.js';
import { sectionDescriptions, sectionEyebrows } from '../dashboardData.js';
import { readPluginsDetails } from '../api.js';
import type { ConfigWebPluginsDetails } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

type PluginView = 'all' | 'issues';

export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<PluginView>('all');
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

  const filteredPlugins = useMemo(() => {
    const plugins = details?.plugins ?? [];
    return view === 'issues' ? plugins.filter((plugin) => plugin.status === 'failed') : plugins;
  }, [details, view]);

  const rows = filteredPlugins.map((plugin) => [
    <div className="table-primary" key={plugin.file}>
      <strong>{plugin.name}</strong>
      <span>{plugin.id}</span>
    </div>,
    <div className="table-tags" key={`${plugin.file}-meta`}>
      <Tag tone="blue">{plugin.extension}</Tag>
      <Tag tone={plugin.status === 'loaded' ? 'green' : plugin.status === 'failed' ? 'red' : 'default'}>{plugin.status ?? 'unknown'}</Tag>
    </div>,
    <span className="table-wrap-text" key={`${plugin.file}-path`}>{plugin.file}</span>,
    <span key={`${plugin.file}-size`}>{formatBytes(plugin.sizeBytes)}</span>,
    <span key={`${plugin.file}-updated`}>{formatDate(plugin.updatedAt)}</span>,
    <span className="table-wrap-text" key={`${plugin.file}-error`}>{plugin.error || '-'}</span>,
  ]);

  return (
    <PageFrame
      eyebrow={sectionEyebrows.plugins}
      title="Plugins"
      description={sectionDescriptions.plugins}
      path={details?.root}
      meta={loading ? 'Refreshing' : 'Observed'}
      stats={[
        { label: 'Plugins', value: String(details?.plugins.length ?? 0), meta: '文件数量' },
        { label: 'Loaded', value: String(details?.plugins.filter((plugin) => plugin.status === 'loaded').length ?? 0), meta: '正常加载' },
        { label: 'Failed', value: String(details?.plugins.filter((plugin) => plugin.status === 'failed').length ?? 0), meta: '需检查' },
      ]}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div className="detail-body detail-body-stacked">
        <div className="section-toolbar">
          <SegmentTabs
            items={[
              { key: 'all', label: 'All Plugins', count: details?.plugins.length ?? 0 },
              { key: 'issues', label: 'Issues', count: details?.plugins.filter((plugin) => plugin.status === 'failed').length ?? 0 },
            ]}
            value={view}
            onChange={(next) => setView(next as PluginView)}
          />
        </div>

        {!details || details.plugins.length === 0 ? (
          <Empty description="暂无文件插件" />
        ) : (
          <DataTable columns={['Plugin', 'Status', 'File', 'Size', 'Updated', 'Error']} rows={rows} emptyMessage="当前视图没有插件项" />
        )}
      </div>
    </PageFrame>
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

