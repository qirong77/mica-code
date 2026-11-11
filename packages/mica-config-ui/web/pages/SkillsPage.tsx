import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownEditor, type MarkdownEditorHandle } from '../../../mica-editor/index.js';
import { createSkill, deleteSkill, readSkillsDetails, writeSkill } from '../api.js';
import { confirmDialog, promptDialog } from '../components/DialogHost.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { useAutoSave } from '../useAutoSave.js';
import type { ConfigWebSkillsDetails } from '../../src/shared/types.js';

/**
 * Skills 列表与 SKILL.md 编辑。
 *
 * 没有保存按钮：停手就写盘。切换条目、刷新、新建之前先把路上那份改动写完，所以不会因为
 * 点快了而丢掉最后几个字。项目外 Skill 只读，自动保存对它们不生效。
 */
export function SkillsPage() {
  const [details, setDetails] = useState<ConfigWebSkillsDetails | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const actionPending = useRef(false);
  const detailsRef = useRef(details);
  const saveError = useRef<string | null>(null);
  detailsRef.current = details;
  const selectedSkill = useMemo(
    () => details?.skills.find((skill) => skill.name === selectedName),
    [details, selectedName],
  );
  const editable = Boolean(selectedSkill?.editable);
  const autoSave = useAutoSave<{ name: string; content: string }, ConfigWebSkillsDetails>({
    save: (next) => writeSkill(next.name, next.content),
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
    if (!selectedName) return;
    schedule({ name: selectedName, content: next });
  }

  async function flushEditor() {
    const value = await editorRef.current?.flush() ?? content;
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

  function applyDetails(next: ConfigWebSkillsDetails, preferredName = selectedName) {
    const selected = next.skills.find((skill) => skill.name === preferredName) ?? next.skills[0];
    detailsRef.current = next;
    setDetails(next);
    setSelectedName(selected?.name ?? '');
    setContent(selected?.content ?? '');
  }

  async function load() {
    await runAction(async () => {
      await flushEditor();
      setLoading(true);
      autoSave.clearError();
      try {
        applyDetails(await readSkillsDetails());
      } finally {
        setLoading(false);
      }
    });
  }

  async function addSkill() {
    await runAction(async () => {
    await flushEditor();
    const name = (
      await promptDialog({
        title: '新建 Skill',
        message: `将创建为 ${details?.root ?? 'skills'}/<名称>/SKILL.md`,
        label: 'Skill 名称',
        placeholder: '例如 pdf-processing',
        confirmText: '创建',
      })
    )?.trim();
    if (!name) return;
      await flushEditor();
      applyDetails(await createSkill(name), name);
    });
  }

  async function removeSkill() {
    if (!selectedSkill || !selectedSkill.editable || busy) return;
    await runAction(async () => {
    const confirmed = await confirmDialog({
      title: `删除 Skill「${selectedSkill.name}」`,
      message: `目录 ${selectedSkill.baseDir} 会被整个删除，此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    await flushEditor();
    autoSave.cancel();
      applyDetails(await deleteSkill(selectedSkill.name));
    });
  }

  async function selectSkill(name: string) {
    if (name === selectedName) return;
    // 先把当前这份写完再换：切换不打断、也不丢正在敲的内容。
    await runAction(async () => {
      await flushEditor();
      const skill = detailsRef.current?.skills.find((item) => item.name === name);
      if (!skill) return;
      setSelectedName(name);
      setContent(skill.content);
    });
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageFrame
      title="Skills"
      description="磁盘上的 skill 目录：这里是唯一能创建与编辑 SKILL.md 的地方，改完下一轮对话即可用"
      path={details?.root}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} disabled={busy} />
          <Button icon={<AddIcon size={15} />} disabled={busy} onClick={() => void addSkill()}>
            新建
          </Button>
          {selectedSkill?.editable ? (
            <Button
              variant="danger"
              icon={<TrashIcon size={15} />}
              title="删除"
              onClick={() => void removeSkill()}
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
                  disabled={busy}
                  className={`role-list-item ${selectedName === skill.name ? 'role-list-item-active' : ''}`}
                  onClick={() => void selectSkill(skill.name)}
                >
                  <span className="role-list-item-copy">
                    <span className="role-list-item-name" title={skill.name}>
                      {skill.name}
                    </span>
                    <span className="role-list-item-sub" title={skill.description}>
                      {skill.description || skill.baseDir}
                    </span>
                  </span>
                  {skill.editable ? null : <Tag>只读</Tag>}
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
                <MarkdownEditor
                  ref={editorRef}
                  documentId={`skill:${selectedSkill?.baseDir ?? selectedName}`}
                  ariaLabel={`Skill ${selectedName}`}
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
