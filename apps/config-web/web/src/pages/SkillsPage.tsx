import { useEffect, useMemo, useState } from 'react';
import { createSkill, deleteSkill, readSkillsDetails, writeSkill } from '../api.js';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebSkillsDetails } from '../../../src/shared/types.js';

export function SkillsPage({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const [details, setDetails] = useState<ConfigWebSkillsDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedSkill = useMemo(
    () => details?.skills.find((skill) => skill.name === selectedName),
    [details, selectedName],
  );
  const dirty = Boolean(selectedSkill && selectedSkill.editable && content !== selectedSkill.content);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;
  const AddIcon = appIcons.add;
  const TrashIcon = appIcons.trash;

  function applyDetails(next: ConfigWebSkillsDetails, preferredName = selectedName) {
    const selected = next.skills.find((skill) => skill.name === preferredName) ?? next.skills[0];
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.content ?? '');
  }

  async function load() {
    if (saving || !confirmDiscardChanges()) return;
    setLoading(true);
    setError(null);
    try {
      applyDetails(await readSkillsDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!selectedSkill || !selectedSkill.editable || saving) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await writeSkill(selectedSkill.name, content), selectedSkill.name);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function addSkill() {
    if (saving || !confirmDiscardChanges()) return;
    const name = window.prompt('Skill 名称（将创建为 skills/<name>/SKILL.md）')?.trim();
    if (!name) return;
    setError(null);
    try {
      applyDetails(await createSkill(name), name);
    } catch (createError) {
      setError(formatError(createError));
    }
  }

  async function removeSkill() {
    if (!selectedSkill || !selectedSkill.editable || saving) return;
    if (!window.confirm(`确定删除 Skill "${selectedSkill.name}" 吗？此操作不可撤销。`)) return;
    setSaving(true);
    setError(null);
    try {
      applyDetails(await deleteSkill(selectedSkill.name));
      setSaved(false);
    } catch (deleteError) {
      setError(formatError(deleteError));
    } finally {
      setSaving(false);
    }
  }

  function selectSkill(name: string) {
    if (saving || name === selectedName || !confirmDiscardChanges()) return;
    const skill = details?.skills.find((item) => item.name === name);
    setSelectedName(name);
    setContent(skill?.content ?? '');
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
    return !dirty || window.confirm('当前 Skill 有未保存的修改，确定要放弃吗？');
  }

  return (
    <PageFrame
      title="Skills"
      path={details?.root}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />
          <Button icon={<AddIcon size={15} />} onClick={addSkill}>
            新建
          </Button>
          {selectedSkill?.editable ? (
            <Button variant="danger" icon={<TrashIcon size={15} />} title="删除" onClick={removeSkill} loading={saving}>
              删除
            </Button>
          ) : null}
          {selectedSkill?.editable ? (
            <Button variant="primary" icon={<SaveIcon size={15} />} onClick={save} loading={saving}>
              保存
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="editor-workspace">
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载 Skills…</div>
        ) : !details ? null : details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : (
          <div className="role-layout">
            <div className="role-list">
              {details.skills.map((skill) => (
                <button
                  key={skill.baseDir}
                  type="button"
                  className={`role-list-item ${selectedName === skill.name ? 'role-list-item-active' : ''}`}
                  disabled={saving}
                  onClick={() => selectSkill(skill.name)}
                >
                  <span>{skill.name}</span>
                  <Tag>{skill.editable ? 'editable' : 'read-only'}</Tag>
                </button>
              ))}
            </div>
            <div className="role-editor-pane">
              <div className="editor-pane-header">
                <div>
                  <h3>{selectedSkill?.name}</h3>
                  {selectedSkill ? <p className="muted-text editor-pane-subtitle">{selectedSkill.baseDir}</p> : null}
                </div>
                {selectedSkill && !selectedSkill.editable ? (
                  <span className="muted-text">项目外 Skill 只读</span>
                ) : null}
              </div>
              <div className="editor-host role-editor-host">
                <MonacoJsonEditor
                  value={content}
                  language="markdown"
                  readOnly={!selectedSkill?.editable || saving}
                  onChange={setContent}
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
