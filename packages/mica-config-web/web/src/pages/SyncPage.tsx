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
  const [loading, setLoading] = useState(false);
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
      {error ? <Alert message={error} /> : null}

      <section className="simple-card">
        <div className="table-panel-title">
          <strong>中心服务器</strong>
          <span>把本机会话镜像到远程服务器，可在浏览器查看并远程续聊</span>
        </div>
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
            <span>机器名称（可选，默认 hostname）</span>
            <input
              className="text-input"
              type="text"
              placeholder="hostname"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          </label>
        </div>
        <div className="form-actions">
          <Button
            variant="primary"
            icon={<SaveIcon size={14} />}
            loading={saving}
            disabled={!serverUrl.trim()}
            onClick={() => void save()}
          >
            {saved ? '已保存' : '保存'}
          </Button>
          <span className="form-hint">
            保存后需启动 daemon 才会开始同步：<code>mica daemon --server {serverUrl.trim() || '&lt;地址&gt;'}</code>
          </span>
        </div>
      </section>

      <section className="simple-card">
        <div className="table-panel-title">
          <strong>状态</strong>
        </div>
        <div className="status-grid">
          <div className="status-item">
            <span className="status-label">配置</span>
            <Tag tone={configured ? 'green' : 'red'}>{configured ? '已配置' : '未配置'}</Tag>
          </div>
          <div className="status-item">
            <span className="status-label">服务器连接</span>
            <Tag tone={serverReachable ? 'green' : 'red'}>{serverReachable ? '可达' : '不可达'}</Tag>
          </div>
          <div className="status-item">
            <span className="status-label">本机 daemon</span>
            <Tag tone={machineOnline ? 'green' : 'red'}>{machineOnline ? '运行中' : '未运行'}</Tag>
          </div>
          {details?.machineId ? (
            <div className="status-item">
              <span className="status-label">机器 ID</span>
              <code className="status-code">{details.machineId.slice(0, 8)}…</code>
            </div>
          ) : null}
        </div>
      </section>

      {configured && serverReachable && details ? (
        <section className="simple-card">
          <div className="table-panel-title">
            <strong>服务器上的机器</strong>
            <span>同一中心服务器上的全部机器</span>
          </div>
          <div className="machine-list">
            {details.machines.length === 0 ? (
              <div className="ui-empty">暂无机器注册</div>
            ) : (
              details.machines.map((machine) => (
                <div className="machine-row" key={machine.id}>
                  <span className="machine-name">{machine.name}</span>
                  <Tag tone={machine.online ? 'green' : 'default'}>{machine.online ? '在线' : '离线'}</Tag>
                  {machine.activeSessionId ? (
                    <code className="status-code">{machine.activeSessionId.slice(0, 8)}…</code>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
