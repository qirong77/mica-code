import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Switch, Tag } from '../components/Ui.js';
import { readPluginsDetails, setPluginEnabled, supportsPluginToggle } from '../api.js';
import type { ConfigWebPlugin, ConfigWebPluginsDetails } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import { pluginSourceLabel, pluginStateLabel, pluginStateTone } from '../labels.js';

/**
 * 插件页：官方插件与用户插件分两组列出，状态与启停都在行上，详情原地展开。
 *
 * 两种插件含义不同，页面上必须说清楚：
 * - 官方插件随产品分发（源码在仓库 `plugins/`），永远「已安装」，只能启用 / 停用；
 * - 用户插件是 `$MICA_HOME/plugins` 下的插件目录，装没装、能不能加载由磁盘决定。
 *
 * 启停只写本地状态文件，插件在启动阶段才注册，因此改完要重开会话才生效——页面提示这一点，
 * 而不是假装立刻生效。
 */
export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;
  const canToggle = supportsPluginToggle();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readPluginsDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(plugin: ConfigWebPlugin, enabled: boolean) {
    setPendingId(plugin.id);
    setError(null);
    setNotice(null);
    try {
      setDetails(await setPluginEnabled(plugin.id, enabled));
      setNotice(`${plugin.name} 已${enabled ? '启用' : '停用'}，重开会话后生效`);
    } catch (toggleError) {
      setError(formatError(toggleError));
    } finally {
      setPendingId(null);
    }
  }

  const plugins = details?.plugins ?? [];
  const official = plugins.filter((plugin) => plugin.source === 'official');
  const user = plugins.filter((plugin) => plugin.source === 'user');
  const enabledCount = plugins.filter((plugin) => plugin.state === 'enabled').length;

  return (
    <PageFrame
      title="Plugins"
      path={details?.root}
      actions={
        <div className="toolbar">
          {notice ? <span className="save-status">{notice}</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
        </div>
      }
    >
      <div className="plugin-page">
        <p className="capability-note">
          插件可以在启动时注册工具、命令、钩子与界面组件。官方插件的源码在仓库{' '}
          <code>{details?.officialDir ?? 'plugins'}</code>，随产品分发；用户插件放在{' '}
          <code>{details?.root ?? '$MICA_HOME/plugins'}</code>，每个插件一个目录（<code>plugin.json</code> 清单 +
          入口）。停用只写 <code>{details?.statePath ?? 'plugins-state.json'}</code>，重开会话才生效。
        </p>
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载 Plugins…</div>
        ) : (
          <>
            <section className="simple-card plugin-card">
              <header className="config-card-head">
                <div className="config-head-copy">
                  <h2>官方插件</h2>
                  <p>内置在产物里，不能卸载；停用后它的工具、命令与钩子都不会注册。</p>
                </div>
                <span className="plugin-head-count">
                  {official.filter((plugin) => plugin.state === 'enabled').length}/{official.length} 启用
                </span>
              </header>
              {official.length === 0 ? (
                <Empty description="没有官方插件" />
              ) : (
                <ul className="plugin-list">
                  {official.map((plugin) => (
                    <PluginRow
                      key={plugin.id}
                      plugin={plugin}
                      expanded={expandedId === plugin.id}
                      busy={pendingId === plugin.id}
                      canToggle={canToggle}
                      onToggleExpanded={() => setExpandedId(expandedId === plugin.id ? null : plugin.id)}
                      onToggleEnabled={(enabled) => void toggle(plugin, enabled)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="simple-card plugin-card">
              <header className="config-card-head">
                <div className="config-head-copy">
                  <h2>用户插件</h2>
                  <p>
                    一个插件就是一个目录：<code>plugin.json</code> + <code>main</code> 指向的入口（default 导出
                    setup），样式、文档等资源在清单的 <code>assets</code> 里声明。
                  </p>
                </div>
                <span className="plugin-head-count">
                  {enabledCount} / {plugins.length} 启用
                </span>
              </header>
              {user.length === 0 ? (
                <Empty description="还没有安装用户插件：把插件目录放进上面那个路径即可" />
              ) : (
                <ul className="plugin-list">
                  {user.map((plugin) => (
                    <PluginRow
                      key={plugin.id}
                      plugin={plugin}
                      expanded={expandedId === plugin.id}
                      busy={pendingId === plugin.id}
                      canToggle={canToggle}
                      onToggleExpanded={() => setExpandedId(expandedId === plugin.id ? null : plugin.id)}
                      onToggleEnabled={(enabled) => void toggle(plugin, enabled)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </PageFrame>
  );
}

type PluginRowProps = {
  plugin: ConfigWebPlugin;
  expanded: boolean;
  busy: boolean;
  canToggle: boolean;
  onToggleExpanded(): void;
  onToggleEnabled(enabled: boolean): void;
};

function PluginRow({ plugin, expanded, busy, canToggle, onToggleExpanded, onToggleEnabled }: PluginRowProps) {
  return (
    <li className={`plugin-row${expanded ? ' is-open' : ''}`}>
      <div className="plugin-row-main">
        <span className="plugin-row-copy">
          <span className="plugin-row-name" title={plugin.name}>
            {plugin.name}
          </span>
          <span className="plugin-row-sub" title={plugin.location}>
            v{plugin.version} · {plugin.location}
          </span>
        </span>
        <span className="plugin-row-tags">
          <Tag tone={plugin.source === 'official' ? 'blue' : 'default'}>{pluginSourceLabel(plugin.source)}</Tag>
          <Tag tone={pluginStateTone(plugin.state)} dot>
            {pluginStateLabel(plugin.state)}
          </Tag>
        </span>
        <span className="plugin-row-actions">
          <Switch
            checked={plugin.state !== 'disabled'}
            disabled={!canToggle || busy}
            label={`${plugin.state === 'disabled' ? '启用' : '停用'}插件 ${plugin.name}`}
            onChange={onToggleEnabled}
          />
          <Button variant="ghost" onClick={onToggleExpanded} title={expanded ? '收起详情' : '展开详情'}>
            {expanded ? '收起' : '详情'}
          </Button>
        </span>
      </div>
      {expanded ? <PluginDetail plugin={plugin} /> : null}
    </li>
  );
}

function PluginDetail({ plugin }: { plugin: ConfigWebPlugin }) {
  return (
    <div className="plugin-row-detail">
      {plugin.description ? <p className="plugin-detail-text">{plugin.description}</p> : null}
      {plugin.error ? <Alert message={plugin.error} /> : null}
      <dl className="plugin-facts">
        <PluginFact label="标识" value={plugin.id} mono />
        <PluginFact label="来源" value={pluginSourceLabel(plugin.source)} />
        <PluginFact label="版本" value={`v${plugin.version}`} />
        <PluginFact label="入口" value={plugin.entryFile || '—'} mono />
        <PluginFact label="清单" value={plugin.manifestFile || '—'} mono />
        <PluginFact
          label="加载"
          value={plugin.loadStatus || (plugin.source === 'official' ? '随启动加载' : '尚未加载')}
        />
        {plugin.author ? <PluginFact label="作者" value={plugin.author} /> : null}
      </dl>
      <div className="plugin-files">
        <span className="plugin-detail-label">文件</span>
        {plugin.files.length === 0 ? (
          <span className="plugin-file-empty">没有可列出的文件</span>
        ) : (
          <ul className="plugin-file-list">
            {plugin.files.map((file) => (
              <li key={file.name}>
                <span className="plugin-file-name" title={file.name}>
                  {file.name}
                </span>
                <span className="plugin-file-size">
                  {typeof file.sizeBytes === 'number' ? formatBytes(file.sizeBytes) : '内置'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PluginFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="plugin-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'plugin-fact-mono' : undefined} title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
