import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { readPluginsDetails } from '../api.js';
import type { ConfigWebPlugin, ConfigWebPluginsDetails } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import { pluginStatusLabel, pluginStatusTone } from '../labels.js';

export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
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

  const plugins = details?.plugins ?? [];
  const selected = plugins.find((plugin) => plugin.file === selectedFile) ?? (plugins.length > 0 ? plugins[0] : null);

  return (
    <PageFrame
      title="Plugins"
      path={details?.root}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      <div className="editor-workspace">
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载 Plugins…</div>
        ) : plugins.length === 0 ? (
          <Empty description="暂无文件插件" />
        ) : (
          <div className="role-layout">
            <div className="role-list">
              {plugins.map((plugin) => (
                <button
                  key={plugin.file}
                  type="button"
                  className={`role-list-item ${selected?.file === plugin.file ? 'role-list-item-active' : ''}`}
                  title={plugin.name}
                  onClick={() => setSelectedFile(plugin.file)}
                >
                  <span className="role-list-item-copy">
                    <span className="role-list-item-name" title={plugin.name}>
                      {plugin.name}
                    </span>
                    <span className="role-list-item-sub" title={plugin.file}>
                      {fileName(plugin.file)}
                    </span>
                  </span>
                  <span className={`role-list-item-dot role-list-item-dot-${pluginStatusTone(plugin.status)}`} />
                </button>
              ))}
            </div>
            {selected ? <PluginDetail plugin={selected} /> : null}
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function PluginDetail({ plugin }: { plugin: ConfigWebPlugin }) {
  return (
    <div className="role-editor-pane plugin-pane">
      <div className="editor-pane-header">
        <div>
          <h3>{plugin.name}</h3>
          <p className="muted-text editor-pane-subtitle" title={plugin.file}>
            {plugin.file}
          </p>
        </div>
        <div className="plugin-pane-tags">
          <Tag>{plugin.extension}</Tag>
          <Tag tone={pluginStatusTone(plugin.status)} dot>
            {pluginStatusLabel(plugin.status)}
          </Tag>
        </div>
      </div>
      <div className="plugin-meta">
        <div className="simple-row">
          <span>大小</span>
          <strong>{formatBytes(plugin.sizeBytes)}</strong>
        </div>
        <div className="simple-row">
          <span>更新</span>
          <strong>{formatDate(plugin.updatedAt)}</strong>
        </div>
        {plugin.error ? <Alert message={plugin.error} /> : null}
      </div>
      <div className="plugin-code-host">
        {plugin.content ? (
          <pre className="code-preview">
            <code>{plugin.content}</code>
          </pre>
        ) : (
          <div className="muted-text">文件为空</div>
        )}
      </div>
    </div>
  );
}

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
