import { useEffect, useMemo, useState } from 'react';
import { createMcpServer, deleteMcpServer, readMcpDetails, writeMcpServer } from '../api.js';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebMcpDetails } from '../../../src/shared/types.js';

export function McpPage({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedServer = useMemo(
    () => details?.servers.find((server) => server.name === selectedName),
    [details, selectedName],
  );
  const dirty = Boolean(selectedServer && content !== selectedServer.config);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;
  const AddIcon = appIcons.add;
  const TrashIcon = appIcons.trash;

  function applyDetails(next: ConfigWebMcpDetails, preferredName = selectedName) {
    const selected = next.servers.find((server) => server.name === preferredName) ?? next.servers[0];
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.config ?? '');
  }

  async function load() {
    if (saving || !confirmDiscardChanges()) return;
    setLoading(true);
    setError(null);
    try {
      applyDetails(await readMcpDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!selectedServer || saving) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await writeMcpServer(selectedServer.name, content), selectedServer.name);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function addServer() {
    if (saving || !confirmDiscardChanges()) return;
    const name = window.prompt('MCP server 名称')?.trim();
    if (!name) return;
    setError(null);
    try {
      applyDetails(await createMcpServer(name), name);
    } catch (createError) {
      setError(formatError(createError));
    }
  }

  async function removeServer() {
    if (!selectedServer || saving) return;
    if (!window.confirm(`确定删除 MCP server "${selectedServer.name}" 吗？此操作不可撤销。`)) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await deleteMcpServer(selectedServer.name));
      setSaved(false);
    } catch (deleteError) {
      setError(formatError(deleteError));
    } finally {
      setSaving(false);
    }
  }

  function selectServer(name: string) {
    if (saving || name === selectedName || !confirmDiscardChanges()) return;
    const server = details?.servers.find((item) => item.name === name);
    setSelectedName(name);
    setContent(server?.config ?? '');
    setSaved(false);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);

  function confirmDiscardChanges(): boolean {
    return !dirty || window.confirm('当前 MCP 配置有未保存的修改，确定要放弃吗？');
  }

  return (
    <PageFrame
      title="MCP"
      path={details?.path}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />
          <Button icon={<AddIcon size={15} />} onClick={addServer}>
            新建
          </Button>
          {selectedServer ? (
            <Button variant="danger" icon={<TrashIcon size={15} />} title="删除" onClick={removeServer} loading={saving}>
              删除
            </Button>
          ) : null}
          {selectedServer ? (
            <Button variant="primary" icon={<SaveIcon size={15} />} onClick={save} loading={saving}>
              保存
            </Button>
          ) : null}
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      {!details || details.servers.length === 0 ? (
        <Empty description="暂无 MCP server" />
      ) : (
        <div className="role-layout">
          <div className="role-list">
            {details.servers.map((server) => (
              <button
                key={server.name}
                type="button"
                className={`role-list-item ${selectedName === server.name ? 'role-list-item-active' : ''}`}
                disabled={saving}
                onClick={() => selectServer(server.name)}
              >
                <span>{server.name}</span>
                <Tag tone={statusColor(server.status)}>{server.status}</Tag>
              </button>
            ))}
          </div>
          <div className="role-editor-pane">
            <div className="editor-pane-header">
              <div>
                <h3>{selectedServer?.name}</h3>
                {selectedServer ? (
                  <p className="muted-text editor-pane-subtitle">
                    {selectedServer.type} · {selectedServer.toolCount} tools
                    {selectedServer.error ? ` · ${selectedServer.error}` : ''}
                  </p>
                ) : null}
              </div>
              {selectedServer ? <Tag tone={statusColor(selectedServer.status)}>{selectedServer.status}</Tag> : null}
            </div>
            <div className="editor-host role-editor-host">
              <MonacoJsonEditor
                value={content}
                language="json"
                readOnly={saving || !selectedServer}
                onChange={setContent}
              />
            </div>
          </div>
        </div>
      )}
    </PageFrame>
  );
}

function statusColor(status: string): 'default' | 'green' | 'red' | 'blue' {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'connecting') return 'blue';
  return 'default';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
