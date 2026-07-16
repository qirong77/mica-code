import { useEffect, useMemo, useState } from 'react';
import { createRole, deleteRole, readRolesDetails, writeRole } from '../api.js';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebRolesDetails } from '../../../src/shared/types.js';

export function RolesPage({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const [details, setDetails] = useState<ConfigWebRolesDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRole = useMemo(
    () => details?.roles.find((role) => role.name === selectedName),
    [details, selectedName],
  );
  const dirty = Boolean(selectedRole && !selectedRole.builtIn && content !== selectedRole.content);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;
  const AddIcon = appIcons.add;
  const TrashIcon = appIcons.trash;

  function applyDetails(next: ConfigWebRolesDetails, preferredName = selectedName) {
    const selected = next.roles.find((role) => role.name === preferredName) ?? next.roles[0];
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.content ?? '');
  }

  async function load() {
    if (saving || !confirmDiscardChanges()) return;
    setLoading(true);
    setError(null);
    try {
      applyDetails(await readRolesDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!selectedRole || selectedRole.builtIn || saving) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await writeRole(selectedRole.name, content), selectedRole.name);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function addRole() {
    if (saving || !confirmDiscardChanges()) return;
    const name = window.prompt('Role 名称（将创建为 .md 文件）')?.trim();
    if (!name) return;
    setError(null);
    try {
      const next = await createRole(name);
      applyDetails(next, name.replace(/\.md$/i, ''));
    } catch (createError) {
      setError(formatError(createError));
    }
  }

  async function removeRole() {
    if (!selectedRole || selectedRole.builtIn || saving) return;
    if (!window.confirm(`确定删除 Role "${selectedRole.name}" 吗？此操作不可撤销。`)) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await deleteRole(selectedRole.name));
      setSaved(false);
    } catch (deleteError) {
      setError(formatError(deleteError));
    } finally {
      setSaving(false);
    }
  }

  function selectRole(name: string) {
    if (saving || name === selectedName || !confirmDiscardChanges()) return;
    const role = details?.roles.find((item) => item.name === name);
    setSelectedName(name);
    setContent(role?.content ?? '');
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
    return !dirty || window.confirm('当前 Role 有未保存的修改，确定要放弃吗？');
  }

  return (
    <PageFrame
      title="Roles"
      path={details?.root}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />
          <Button icon={<AddIcon size={15} />} onClick={addRole}>
            新建
          </Button>
          {!selectedRole?.builtIn ? (
            <Button icon={<TrashIcon size={15} />} title="删除" onClick={removeRole} loading={saving}>
              删除
            </Button>
          ) : null}
          {!selectedRole?.builtIn ? (
            <Button variant="primary" icon={<SaveIcon size={15} />} onClick={save} loading={saving}>
              保存
            </Button>
          ) : null}
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      {!details || details.roles.length === 0 ? (
        <Empty description="暂无 Role" />
      ) : (
        <div className="role-layout">
          <div className="role-list">
            {details.roles.map((role) => (
              <button
                key={role.name}
                type="button"
                className={`role-list-item ${selectedName === role.name ? 'role-list-item-active' : ''}`}
                disabled={saving}
                onClick={() => selectRole(role.name)}
              >
                <span>{role.name}</span>
                <Tag tone={role.builtIn ? 'default' : 'blue'}>{role.builtIn ? 'built-in' : 'editable'}</Tag>
              </button>
            ))}
          </div>
          <div className="role-editor-pane">
            <div className="editor-pane-header">
              <h3>{selectedRole?.name}</h3>
              {selectedRole?.builtIn ? <span className="muted-text">内置 Role 只读</span> : null}
            </div>
            <div className="editor-host role-editor-host">
              <MonacoJsonEditor
                value={content}
                language="markdown"
                readOnly={(selectedRole?.builtIn ?? true) || saving}
                onChange={setContent}
              />
            </div>
          </div>
        </div>
      )}
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
