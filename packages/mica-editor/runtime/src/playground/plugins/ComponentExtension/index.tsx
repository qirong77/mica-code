import {
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import { type JSX, useId, useState } from 'react';

import { $createComponentNode } from '../../nodes/ComponentNode';
import Button from '../../ui/Button';
import { DialogActions } from '../../ui/Dialog';
import { insertBlockNode } from '../insertBlock';

export type InsertComponentPayload = Readonly<{
  code: string;
}>;

export const INSERT_COMPONENT_COMMAND: LexicalCommand<InsertComponentPayload> =
  createCommand('INSERT_COMPONENT_COMMAND');

export const DEFAULT_COMPONENT_BLOCK = `function App({React, Arco, html}) {
  const {Card, Button, Tag} = Arco;
  const [count, setCount] = React.useState(0);
  return html\`<\${Card} title="快速原型">
    <p>少量代码即可使用 Mica 的 Arco 组件。</p>
    <\${Tag} color="arcoblue">可交互</\${Tag}>
    <\${Button} type="primary" onClick=\${() => setCount(count + 1)}>
      点击了 \${count} 次
    </\${Button}>
  </\${Card}>\`;
}`;

const DIALOG_HINT =
  '用 function App({React, Arco, html}) 定义组件，支持 React hooks、Arco 组件和 htm 模板。';

export function insertComponentBlock(editor: LexicalEditor, payload: InsertComponentPayload): void {
  insertBlockNode(editor, () => $createComponentNode(payload.code));
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
  const [error, setError] = useState('');
  const sourceId = useId();

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
      <div className="block-insert-source">
        <div className="block-insert-source-head">
          <label htmlFor={sourceId}>组件代码</label>
        </div>
        <textarea
          id={sourceId}
          autoFocus
          value={code}
          spellCheck={false}
          wrap="off"
          onChange={(event) => setCode(event.target.value)}
          placeholder={DEFAULT_COMPONENT_BLOCK}
        />
      </div>
      <p className="block-insert-hint">{DIALOG_HINT}</p>
      <details className="block-insert-help">
        <summary>使用说明</summary>
        <p>使用 htm 模板代替 JSX。组件在独立沙箱中运行，交互状态仅保留在块内；无法读取笔记或宿主页面，只能向组件 CDN 请求资源，高度上限 1200px。插入后可通过右上角「编辑组件」修改源码。</p>
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
