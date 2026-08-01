import { useEffect, useRef, useState } from 'react';
import { readSyncDetails, writeSyncConfig } from '../api.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebSyncDetails } from '../../../src/shared/types.js';

export function SyncPage() {
  const [details, setDetails] = useState<ConfigWebSyncDetails | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const SaveIcon = appIcons.save;
  const RefreshIcon = appIcons.refresh;

  async function load() {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const next = await readSyncDetails();
      if (requestSequence.current !== sequence) return;
      setDetails(next);
      setServerUrl(next.serverUrl);
      setName(next.name);
      setError(null);
      setSaved(false);
    } catch (loadError) {
      if (requestSequence.current === sequence) setError(formatError(loadError));
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const next = await writeSyncConfig(serverUrl, name);
      setDetails(next);
      setServerUrl(next.serverUrl);
      setName(next.name);
      setError(null);
      setSaved(true);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  const configured = details?.configured ?? false;
  const serverReachable = details?.serverReachable ?? false;
  const machineOnline = details?.machineOnline ?? false;
  const dirty = details ? serverUrl.trim() !== details.serverUrl || name.trim() !== details.name : false;

  return (
    <PageFrame
      title="Sync · 远程中心"
      path={details?.configPath ?? ''}
      actions={
        <Button icon={<RefreshIcon size={14} />} loading={loading} title="刷新状态" onClick={() => void load()}>
          刷新
        </Button>
      }
    >
      <div className="sync-page">
        {error ? <Alert message={error} /> : null}
        {!details && loading ? <div className="page-loading">正在加载同步状态…</div> : null}
        {details ? (
          <>
            <section className="simple-card sync-card">
              <header className="sync-card-header">
                <div className="table-panel-title">
                  <strong>中心服务器</strong>
                  <span>把本机会话镜像到远程服务器，可在浏览器查看并远程续聊</span>
                </div>
              </header>
              <div className="sync-card-body">
                <div className="form-grid">
                  <label className="form-field">
                    <span>服务器地址</span>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="http://host:5560"
                      value={serverUrl}
                      onChange={(event) => {
                        setServerUrl(event.target.value);
                        setSaved(false);
                      }}
                    />
                  </label>
                  <label className="form-field">
                    <span>机器名称</span>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="可选，默认使用 hostname"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setSaved(false);
                      }}
                    />
                  </label>
                </div>
              </div>
              <footer className="sync-form-footer">
                <div className="sync-command">
                  <span>启动 daemon</span>
                  <code>mica daemon --server {serverUrl.trim() || '&lt;地址&gt;'}</code>
                </div>
                <Button
                  variant="primary"
                  icon={<SaveIcon size={14} />}
                  loading={saving}
                  disabled={!serverUrl.trim() || !dirty}
                  onClick={() => void save()}
                >
                  {saved ? '已保存' : '保存配置'}
                </Button>
              </footer>
            </section>

            <section className="simple-card sync-card sync-status-card">
              <header className="sync-card-header">
                <div className="table-panel-title">
                  <strong>运行状态</strong>
                  <span>配置、网络连接与本机同步进程的当前状态</span>
                </div>
              </header>
              <div className="status-grid">
                <div className="status-item">
                  <span className="status-label">配置</span>
                  <Tag tone={configured ? 'green' : 'red'} dot>
                    {configured ? '已配置' : '未配置'}
                  </Tag>
                </div>
                <div className="status-item">
                  <span className="status-label">服务器连接</span>
                  <Tag tone={serverReachable ? 'green' : 'red'} dot>
                    {serverReachable ? '可达' : '不可达'}
                  </Tag>
                </div>
                <div className="status-item">
                  <span className="status-label">本机 daemon</span>
                  <Tag tone={machineOnline ? 'green' : 'red'} dot>
                    {machineOnline ? '运行中' : '未运行'}
                  </Tag>
                </div>
                {details?.machineId ? (
                  <div className="status-item">
                    <span className="status-label">机器 ID</span>
                    <code className="status-code">{details.machineId.slice(0, 8)}</code>
                  </div>
                ) : null}
              </div>
            </section>

            {configured && serverReachable ? (
              <section className="simple-card sync-card">
                <header className="sync-card-header sync-card-header-row">
                  <div className="table-panel-title">
                    <strong>服务器上的机器</strong>
                    <span>连接到同一中心服务器的全部机器</span>
                  </div>
                  <span className="sync-count">{details.machines.length}</span>
                </header>
                <div className="machine-list">
                  {details.machines.length === 0 ? (
                    <div className="sync-empty">暂无机器注册</div>
                  ) : (
                    details.machines.map((machine) => (
                      <div className="machine-row" key={machine.id}>
                        <span
                          className={`status-lamp ${machine.online ? 'status-lamp-online' : 'status-lamp-offline'}`}
                          aria-hidden="true"
                        />
                        <div className="machine-copy">
                          <strong className="machine-name">{machine.name}</strong>
                          <code>{machine.id.slice(0, 8)}</code>
                        </div>
                        <div className="machine-meta">
                          {machine.id === details.machineId ? <Tag>本机</Tag> : null}
                          {machine.activeSessionId ? (
                            <span className="machine-session">
                              活跃会话 <code>{machine.activeSessionId.slice(0, 8)}</code>
                            </span>
                          ) : null}
                          <Tag tone={machine.online ? 'green' : 'default'} dot>
                            {machine.online ? '在线' : '离线'}
                          </Tag>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
