import { useEffect, useMemo, useState } from 'react';
import { createMcpServer, deleteMcpServer, readMcpDetails, writeMcpServer } from '../api.js';
import { confirmDialog, promptDialog } from '../components/DialogHost.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { mcpStatusLabel, mcpStatusTone, mcpTypeLabel } from '../labels.js';
import { useAutoSave } from '../useAutoSave.js';
import type { ConfigWebMcpDetails, ConfigWebMcpServer } from '../../src/shared/types.js';

/**
 * MCP server 列表，直接编辑 config.json 里 `mcpServers` 的单个条目。
 *
 * 没有保存按钮：停手就写盘。切换条目、刷新、新建之前先把路上那份改动写完。
 */
export function McpPage() {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedServer = useMemo(
    () => details?.servers.find((server) => server.name === selectedName),
    [details, selectedName],
  );
  const autoSave = useAutoSave<{ name: string; content: string }, ConfigWebMcpDetails>({
    save: (next) => writeMcpServer(next.name, next.content),
    onSaved: (next) => setDetails(next),
  });
  const { schedule, flush } = autoSave;
  const RefreshIcon = appIcons.refresh;
  const AddIcon = appIcons.add;
  const TrashIcon = appIcons.trash;

  /**
   * 改动当场登记写盘。
   *
   * 不用 effect 兜：改完立刻切页面时，卸载和这次改动落在同一批更新里，被卸载的组件不会
   * 再跑 effect，那一批改动就没人登记了。
   */
  function editContent(next: string) {
    setContent(next);
    if (!selectedName || !selectedServer) return;
    if (next === selectedServer.config) return;
    schedule({ name: selectedName, content: next });
  }

  function applyDetails(next: ConfigWebMcpDetails, preferredName = selectedName) {
    const selected = next.servers.find((server) => server.name === preferredName) ?? next.servers[0];
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.config ?? '');
  }

  async function load() {
    await flush();
    setLoading(true);
    setError(null);
    autoSave.clearError();
    try {
      applyDetails(await readMcpDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function addServer() {
    if (busy) return;
    await flush();
    const name = (
      await promptDialog({
        title: '新建 MCP server',
        message: '将写入 config.json 的 mcpServers。',
        label: '名称',
        placeholder: '例如 sequential-thinking',
        confirmText: '创建',
      })
    )?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      applyDetails(await createMcpServer(name), name);
    } catch (createError) {
      setError(formatError(createError));
    } finally {
      setBusy(false);
    }
  }

  async function removeServer() {
    if (!selectedServer || busy) return;
    const confirmed = await confirmDialog({
      title: `删除 MCP server「${selectedServer.name}」`,
      message: '此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    // 这个条目马上要没了，路上那份改动不必再写回去。
    autoSave.cancel();
    setBusy(true);
    setError(null);
    try {
      applyDetails(await deleteMcpServer(selectedServer.name));
    } catch (deleteError) {
      setError(formatError(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function selectServer(name: string) {
    if (name === selectedName) return;
    // 先把当前这份写完再换：切换不打断、也不丢正在敲的内容。
    await flush();
    const server = details?.servers.find((item) => item.name === name);
    setSelectedName(name);
    setContent(server?.config ?? '');
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageFrame
      title="MCP"
      path={details?.path}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
          <Button icon={<AddIcon size={15} />} disabled={busy} onClick={() => void addServer()}>
            新建
          </Button>
          {selectedServer ? (
            <Button
              variant="danger"
              icon={<TrashIcon size={15} />}
              title="删除"
              onClick={() => void removeServer()}
              loading={busy}
            >
              删除
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="editor-workspace">
        {error ? <Alert message={error} /> : null}
        {autoSave.error ? <Alert message={autoSave.error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载 MCP 配置…</div>
        ) : !details ? null : details.servers.length === 0 ? (
          <Empty description="暂无 MCP server" />
        ) : (
          <div className="role-layout">
            <div className="role-list">
              {details.servers.map((server) => (
                <button
                  key={server.name}
                  type="button"
                  className={`role-list-item ${selectedName === server.name ? 'role-list-item-active' : ''}`}
                  onClick={() => void selectServer(server.name)}
                >
                  <span className="role-list-item-copy">
                    <span className="role-list-item-name" title={server.name}>
                      {server.name}
                    </span>
                    <span className="role-list-item-sub" title={server.target}>
                      {server.target || mcpTypeLabel(server.type)}
                    </span>
                  </span>
                  <span
                    className={`role-list-item-dot role-list-item-dot-${mcpStatusTone(server.status)}`}
                    title={mcpStatusLabel(server.status)}
                  />
                </button>
              ))}
            </div>
            <div className="role-editor-pane">
              <div className="editor-pane-header">
                <div>
                  <h3>{selectedServer?.name}</h3>
                  {selectedServer ? (
                    <p className="muted-text editor-pane-subtitle">
                      {mcpSubtitle(selectedServer)}
                      {selectedServer.error ? ` · ${selectedServer.error}` : ''}
                    </p>
                  ) : null}
                </div>
                {selectedServer ? (
                  <Tag tone={mcpStatusTone(selectedServer.status)} dot>
                    {mcpStatusLabel(selectedServer.status)}
                  </Tag>
                ) : null}
              </div>
              <div className="editor-host role-editor-host">
                <JsonEditor value={content} language="json" readOnly={!selectedServer} onChange={editContent} />
              </div>
            </div>
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 详情副标题。
 *
 * http server 在打开页面时就握过手，工具数是真的；stdio 的进程只在会话里起，所以这里不写
 * 「0 个工具」——那会读成「配了个空的」，改为说明连接时机。
 */
function mcpSubtitle(server: ConfigWebMcpServer): string {
  const type = mcpTypeLabel(server.type);
  if (server.status === 'connected') return `${type} · ${server.toolCount} 个工具`;
  if (server.type === 'stdio') return `${type} · 启动会话时连接`;
  return type;
}
