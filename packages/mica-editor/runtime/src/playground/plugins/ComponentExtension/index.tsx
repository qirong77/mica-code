import {
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useId, useMemo, useRef, useState} from 'react';

import {
  COMPONENT_TEMPLATES,
  DEFAULT_COMPONENT_TEMPLATE,
  DEFAULT_COMPONENT_TEMPLATE_ID,
} from '../../../../../componentCatalog';
import { $createComponentNode, buildComponentDocument } from '../../nodes/ComponentNode';
import {SandboxBlock, useBlockTheme} from '../../nodes/sandboxBlock';
import Button from '../../ui/Button';
import { DialogActions } from '../../ui/Dialog';
import Select from '../../ui/Select';
import { insertBlockNode } from '../insertBlock';

export type InsertComponentPayload = Readonly<{
  code: string;
}>;

export const INSERT_COMPONENT_COMMAND: LexicalCommand<InsertComponentPayload> =
  createCommand('INSERT_COMPONENT_COMMAND');

export const DEFAULT_COMPONENT_BLOCK = DEFAULT_COMPONENT_TEMPLATE.code;

const DIALOG_HINT =
  '用 function App({React, Arco, html}) 定义组件，支持 React hooks、Arco 组件、原生 HTML/SVG 和 htm 模板；不要写 JSX、import、fetch 或访问宿主笔记。可先打开预览，确认后再插入。';

export function insertComponentBlock(editor: LexicalEditor, payload: InsertComponentPayload): void {
  insertBlockNode(editor, () => $createComponentNode(payload.code));
}

function ComponentDraftPreview({code}: {code: string}): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const theme = useBlockTheme(anchorRef);
  const document = useMemo(() => buildComponentDocument(code, theme), [code]);
  return (
    <div ref={anchorRef} className="block-insert-component-preview">
      <SandboxBlock
        document={document}
        editLabel="编辑组件"
        frameTitle="组件草稿预览"
        source={code}
        height={260}
        editable={false}
        onSave={() => {}}
      />
    </div>
  );
}

function InsertComponentDialog({
  activeEditor,
  onClose,
  onInsert,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
  onInsert?: (payload: InsertComponentPayload) => void;
}): JSX.Element {
  const [code, setCode] = useState(DEFAULT_COMPONENT_BLOCK);
  const [templateId, setTemplateId] = useState(DEFAULT_COMPONENT_TEMPLATE_ID);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [view, setView] = useState<'source' | 'preview'>('source');
  const [error, setError] = useState('');
  const sourceId = useId();
  const template = COMPONENT_TEMPLATES.find(item => item.id === templateId) ?? DEFAULT_COMPONENT_TEMPLATE;

  const applyTemplate = (nextTemplate: (typeof COMPONENT_TEMPLATES)[number]) => {
    setTemplateId(nextTemplate.id);
    setCode(nextTemplate.code);
    setPendingTemplateId(null);
    setView('source');
    setError('');
  };

  const selectTemplate = (nextId: string) => {
    if (nextId === templateId) return;
    const nextTemplate = COMPONENT_TEMPLATES.find(item => item.id === nextId);
    if (!nextTemplate) return;
    const hasDraftChanges = code !== template.code;
    if (hasDraftChanges) {
      setPendingTemplateId(nextTemplate.id);
      return;
    }
    applyTemplate(nextTemplate);
  };

  const pendingTemplate = pendingTemplateId
    ? COMPONENT_TEMPLATES.find(item => item.id === pendingTemplateId)
    : undefined;

  const insert = () => {
    const next = code.trim();
    if (!next) {
      setError('请输入组件代码。');
      return;
    }
    const payload: InsertComponentPayload = { code: next };
    if (onInsert) onInsert(payload);
    else insertComponentBlock(activeEditor, payload);
    onClose();
  };

  return (
    <div className="block-insert-dialog">
      <div className="block-insert-template">
        <Select
          id="component-template"
          label="模板"
          value={templateId}
          onChange={event => selectTemplate(event.target.value)}
        >
          {COMPONENT_TEMPLATES.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <p className="block-insert-template-description">{template.description}</p>
      </div>
      {pendingTemplate ? (
        <div className="block-insert-template-confirm" role="alert">
          <p>当前源码已修改，切换到「{pendingTemplate.name}」会替换草稿。</p>
          <div className="block-insert-template-confirm-actions">
            <Button small secondary onClick={() => setPendingTemplateId(null)}>保留草稿</Button>
            <Button small onClick={() => applyTemplate(pendingTemplate)}>替换模板</Button>
          </div>
        </div>
      ) : null}
      <div className="block-insert-source">
        <div className="block-insert-source-head">
          <label htmlFor={sourceId}>组件代码</label>
          <div className="block-insert-view-tabs" role="tablist" aria-label="组件查看方式">
            {(['source', 'preview'] as const).map(nextView => (
              <button
                type="button"
                key={nextView}
                className={view === nextView ? 'block-insert-view-tab is-active' : 'block-insert-view-tab'}
                role="tab"
                aria-selected={view === nextView}
                onClick={() => setView(nextView)}
              >
                {nextView === 'source' ? '源码' : '运行预览'}
              </button>
            ))}
          </div>
        </div>
        {view === 'preview' ? (
          <ComponentDraftPreview code={code} />
        ) : (
          <textarea
            id={sourceId}
            autoFocus
            value={code}
            spellCheck={false}
            wrap="off"
            onChange={(event) => setCode(event.target.value)}
            placeholder={DEFAULT_COMPONENT_BLOCK}
          />
        )}
      </div>
      <p className="block-insert-hint">{DIALOG_HINT}</p>
      <details className="block-insert-help">
        <summary>使用说明</summary>
        <p>使用 htm 模板代替 JSX。组件在独立沙箱中运行，交互状态仅保留在块内；可使用 React hooks、Arco 组件与原生 HTML/SVG，不可 import、fetch、读取笔记或宿主页面。运行时依赖固定版本的 CDN，高度上限 1200px。插入后可通过右上角「编辑组件」修改源码。</p>
      </details>
      {error && (
        <p className="block-insert-error" role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button small secondary onClick={onClose}>
          取消
        </Button>
        <Button small onClick={insert}>
          插入组件块
        </Button>
      </DialogActions>
    </div>
  );
}

export { InsertComponentDialog };

export const ComponentExtension = defineExtension({
  name: '@mica/editor/Component',
  register: (editor) =>
    editor.registerCommand(
      INSERT_COMPONENT_COMMAND,
      (payload) => {
        insertComponentBlock(editor, payload);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
