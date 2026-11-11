import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEditor, type MarkdownEditorHandle } from '../../../mica-editor/index.js';
import { createRole, deleteRole, readRolesDetails, writeRole } from '../api.js';
import { confirmDialog, promptDialog } from '../components/DialogHost.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { ROLE_LABELS } from '../labels.js';
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
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const actionPending = useRef(false);
  const detailsRef = useRef(details);
  const saveError = useRef<string | null>(null);
  detailsRef.current = details;
  const selectedRole = useMemo(
    () => details?.roles.find((role) => role.name === selectedName),
    [details, selectedName],
  );
  const isDefault = selectedRole?.name === 'default';
  const editable = Boolean(selectedRole) && !isDefault && !selectedRole?.builtIn;
  const autoSave = useAutoSave<{ name: string; content: string }, ConfigWebRolesDetails>({
    save: (next) => writeRole(next.name, next.content),
    onSaved: (next) => {
      detailsRef.current = next;
      saveError.current = null;
      setDetails(next);
    },
    onError: (message) => { saveError.current = message; },
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
    if (!editable) return;
    setContent(next);
    setCopiedName(null);
    if (!selectedName) return;
    schedule({ name: selectedName, content: next });
  }

  async function flushEditor() {
    const value = await editorRef.current?.flush() ?? content;
    // A failed write is retried from the editor's current source, not from an old server response.
    if (editable && saveError.current) schedule({ name: selectedName, content: value });
    await flush();
    if (saveError.current) throw new Error(saveError.current);
    return value;
  }

  async function runAction(action: () => Promise<void>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }

  function applyDetails(next: ConfigWebRolesDetails, preferredName = selectedName) {
    const selected = next.roles.find((role) => role.name === preferredName) ?? next.roles[0];
    detailsRef.current = next;
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.content ?? '');
    setCopiedName(null);
  }

  async function load() {
    await runAction(async () => {
      await flushEditor();
      setLoading(true);
      autoSave.clearError();
      try {
        applyDetails(await readRolesDetails());
      } finally {
        setLoading(false);
      }
    });
  }

  async function addRole() {
    await runAction(async () => {
    await flushEditor();
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
      await flushEditor();
      const next = await createRole(name);
      applyDetails(next, name.replace(/\.md$/i, ''));
    });
  }

  async function removeRole() {
    if (!selectedRole || !editable || busy) return;
    await runAction(async () => {
    const confirmed = await confirmDialog({
      title: `删除 Role「${selectedRole.name}」`,
      message: '此操作不可撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    await flushEditor();
    autoSave.cancel();
      applyDetails(await deleteRole(selectedRole.name));
    });
  }

  async function selectRole(name: string) {
    if (name === selectedName) return;
    // 先把当前这份写完再换：切换不打断、也不丢正在敲的内容。
    await runAction(async () => {
      await flushEditor();
      const role = detailsRef.current?.roles.find((item) => item.name === name);
      if (!role) return;
      setSelectedName(name);
      setContent(role.content);
      setCopiedName(null);
    });
  }

  async function copyContent() {
    if (!navigator.clipboard?.writeText) {
      setError(ROLE_LABELS.copyUnsupported);
      return;
    }
    try {
      const value = await editorRef.current?.flush() ?? content;
      await navigator.clipboard.writeText(value);
      setCopiedName(selectedName);
    } catch (cause) {
      setError(`${ROLE_LABELS.copyFailed} ${formatError(cause)}`);
    }
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageFrame
      title="Roles"
      description={ROLE_LABELS.description}
      path={details?.root}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} disabled={busy} />
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
                  disabled={busy}
                  className={`role-list-item ${selectedName === role.name ? 'role-list-item-active' : ''}`}
                  onClick={() => void selectRole(role.name)}
                >
                  <span className="role-list-item-copy">
                    <span className="role-list-item-name" title={role.name}>
                      {role.name}
                    </span>
                    {role.name === 'default' ? (
                      <span className="role-list-item-sub">{ROLE_LABELS.defaultPrompt}</span>
                    ) : null}
                  </span>
                  {role.builtIn || role.name === 'default' ? <Tag>{ROLE_LABELS.readOnly}</Tag> : null}
                </button>
              ))}
            </div>
            <div className="role-editor-pane">
              <div className="editor-pane-header role-prompt-header">
                <div>
                  <h3>{isDefault ? ROLE_LABELS.defaultPrompt : selectedRole?.name}</h3>
                  <p className="muted-text editor-pane-subtitle">
                    {isDefault ? ROLE_LABELS.defaultDescription : ROLE_LABELS.appendedPrompt}
                  </p>
                </div>
                <Button variant="ghost" disabled={!selectedRole} onClick={() => void copyContent()}>
                  {copiedName === selectedName ? ROLE_LABELS.copied : ROLE_LABELS.copy}
                </Button>
              </div>
              <div className="editor-host role-editor-host">
                <MarkdownEditor
                  ref={editorRef}
                  documentId={`role:${details.root}/${selectedName}`}
                  ariaLabel={isDefault ? ROLE_LABELS.defaultPrompt : `Role ${selectedName}`}
                  value={content}
                  readOnly={!editable}
                  onChange={editContent}
                />
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
