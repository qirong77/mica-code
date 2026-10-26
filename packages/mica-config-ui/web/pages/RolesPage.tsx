import { useEffect, useMemo, useState } from 'react';
import { createRole, deleteRole, readRolesDetails, writeRole } from '../api.js';
import { confirmDialog, promptDialog } from '../components/DialogHost.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { useAutoSave } from '../useAutoSave.js';
import type { ConfigWebRolesDetails } from '../../src/shared/types.js';

/**
 * Roles 列表与角色 prompt 编辑。
 *
 * 没有保存按钮：停手就写盘。内置 Role 只读，自动保存对它们不生效；切换条目、刷新、新建
 * 之前先把路上那份改动写完。
 */
export function RolesPage() {
  const [details, setDetails] = useState<ConfigWebRolesDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRole = useMemo(
    () => details?.roles.find((role) => role.name === selectedName),
    [details, selectedName],
  );
  const editable = Boolean(selectedRole) && !selectedRole?.builtIn;
  const autoSave = useAutoSave<{ name: string; content: string }, ConfigWebRolesDetails>({
    save: (next) => writeRole(next.name, next.content),
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
    if (!editable || !selectedName) return;
    if (next === (selectedRole?.content ?? '')) return;
    schedule({ name: selectedName, content: next });
  }

  function applyDetails(next: ConfigWebRolesDetails, preferredName = selectedName) {
    const selected = next.roles.find((role) => role.name === preferredName) ?? next.roles[0];
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.content ?? '');
  }

  async function load() {
    await flush();
    setLoading(true);
    setError(null);
    autoSave.clearError();
    try {
      applyDetails(await readRolesDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function addRole() {
    if (busy) return;
    await flush();
    const name = (
      await promptDialog({
        title: '新建 Role',
        message: `将创建为 ${details?.root ?? 'role'}/<名称>.md`,
        label: 'Role 名称',
        placeholder: '例如 reviewer',
        confirmText: '创建',
      })
    )?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const next = await createRole(name);
      applyDetails(next, name.replace(/\.md$/i, ''));
    } catch (createError) {
      setError(formatError(createError));
    } finally {
      setBusy(false);
    }
  }

  async function removeRole() {
    if (!selectedRole || selectedRole.builtIn || busy) return;
    const confirmed = await confirmDialog({
      title: `删除 Role「${selectedRole.name}」`,
      message: '此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    // 这个文件马上要没了，路上那份改动不必再写回去。
    autoSave.cancel();
    setBusy(true);
    setError(null);
    try {
      applyDetails(await deleteRole(selectedRole.name));
    } catch (deleteError) {
      setError(formatError(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function selectRole(name: string) {
    if (name === selectedName) return;
    // 先把当前这份写完再换：切换不打断、也不丢正在敲的内容。
    await flush();
    const role = details?.roles.find((item) => item.name === name);
    setSelectedName(name);
    setContent(role?.content ?? '');
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageFrame
      title="Roles"
      path={details?.root}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
          <Button icon={<AddIcon size={15} />} disabled={busy} onClick={() => void addRole()}>
            新建
          </Button>
          {editable ? (
            <Button
              variant="danger"
              icon={<TrashIcon size={15} />}
              title="删除"
              onClick={() => void removeRole()}
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
          <div className="page-loading">正在加载 Roles…</div>
        ) : !details ? null : details.roles.length === 0 ? (
          <Empty description="暂无 Role" />
        ) : (
          <div className="role-layout">
            <div className="role-list">
              {details.roles.map((role) => (
                <button
                  key={role.name}
                  type="button"
                  className={`role-list-item ${selectedName === role.name ? 'role-list-item-active' : ''}`}
                  onClick={() => void selectRole(role.name)}
                >
                  <span className="role-list-item-copy">
                    <span className="role-list-item-name" title={role.name}>
                      {role.name}
                    </span>
                  </span>
                  {role.builtIn ? <Tag>内置</Tag> : null}
                </button>
              ))}
            </div>
            <div className="role-editor-pane">
              <div className="editor-pane-header">
                <h3>{selectedRole?.name}</h3>
                {selectedRole?.builtIn ? <span className="muted-text">内置 Role 只读</span> : null}
              </div>
              <div className="editor-host role-editor-host">
                <JsonEditor value={content} language="markdown" readOnly={!editable} onChange={editContent} />
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
