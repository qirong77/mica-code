import {Slider} from '@arco-design/web-react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {COMMAND_PRIORITY_LOW, HISTORY_PUSH_TAG, mergeRegister, SELECTION_CHANGE_COMMAND} from 'lexical';
import {useEffect, useId, useRef, useState} from 'react';

import {Button, Segmented} from '../../../../mica-config-ui/web/components/Ui';
import {
  $readDocumentStyle, $updateDocumentStyle, DEFAULT_DOCUMENT_STYLE,
  DOCUMENT_BODY_SIZES, documentStyleVariables, type NotebookDocumentStyle,
} from './documentStyle';
import {NOTEBOOK_ACTION_COMMAND} from './notebookActions';

function PageSizeOption({wide = false}: {wide?: boolean}) {
  return <span className="notebook-page-option">
    <svg width="40" height="30" viewBox="0 0 40 30" fill="none" aria-hidden="true">
      <rect x="5" y="2" width="30" height="26" rx="3" fill="currentColor" opacity=".12" />
      <path d={wide ? 'M10 9h20M10 13h20M10 17h20M10 21h13' : 'M14 9h12M14 13h12M14 17h12M14 21h8'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
    <span>{wide ? '超宽模式' : '标宽模式'}</span>
  </span>;
}

export default function NotebookDocumentStyle() {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<NotebookDocumentStyle>(() => editor.getEditorState().read($readDocumentStyle));
  const applied = useRef<{workspace: HTMLElement; style: NotebookDocumentStyle} | null>(null);
  const sizeLabel = useId();

  useEffect(() => {
    const sync = () => {
      const current = editor.getEditorState().read($readDocumentStyle);
      const workspace = editor.getRootElement()?.closest<HTMLElement>('.notebook-workbench');
      if (workspace && (applied.current?.workspace !== workspace || applied.current.style !== current)) {
        setStyle(current);
        for (const [key, value] of Object.entries(documentStyleVariables(current))) workspace.style.setProperty(key, value);
        applied.current = {workspace, style: current};
        // The toolbar reads computed sizes; refresh after applying document CSS.
        queueMicrotask(() => editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined));
      }
    };
    sync();
    return mergeRegister(
      editor.registerRootListener(sync),
      editor.registerUpdateListener(sync),
      editor.registerCommand(NOTEBOOK_ACTION_COMMAND, action => {
        if (action === 'style') {setOpen(previous => !previous); return false;}
        setOpen(false);
        return false;
      }, COMMAND_PRIORITY_LOW),
    );
  }, [editor]);

  useEffect(() => {
    if (!open) return;
    document.body.dataset.notebookStyle = 'open';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setOpen(false);
        editor.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      delete document.body.dataset.notebookStyle;
      window.removeEventListener('keydown', escape);
    };
  }, [editor, open]);

  const change = (patch: Partial<NotebookDocumentStyle>) => {
    if (editor.isEditable()) editor.update(() => $updateDocumentStyle(patch), {tag: HISTORY_PUSH_TAG});
  };

  if (!open) return null;
  return (
    <aside className="notebook-document-panel notebook-style-panel" aria-label="样式设置">
      <header className="notebook-panel-header">
        <strong>样式设置</strong>
        <Button variant="ghost" size="compact" title="关闭样式设置" onClick={() => setOpen(false)} icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        } />
      </header>
      <div className="notebook-panel-content">
        <p className="notebook-panel-hint">仅作用于当前文档，自动保存。单独设置过的文字格式保持原样。</p>
        <section className="notebook-style-setting">
          <label>页面尺寸</label>
          <Segmented variant="cards" value={style.pageSize} ariaLabel="页面尺寸" disabled={!editable} options={[
            {value: 'standard', label: <PageSizeOption />}, {value: 'wide', label: <PageSizeOption wide />},
          ]} onChange={value => change({pageSize: value as NotebookDocumentStyle['pageSize']})} />
        </section>
        <section className="notebook-style-setting">
          <label id={sizeLabel}>正文大小</label>
          <div className="notebook-body-size-control">
            <Slider min={0} max={DOCUMENT_BODY_SIZES.length - 1} step={1} showTicks disabled={!editable}
              aria-labelledby={sizeLabel} value={DOCUMENT_BODY_SIZES.indexOf(style.bodySize as typeof DOCUMENT_BODY_SIZES[number])}
              formatTooltip={index => `${DOCUMENT_BODY_SIZES[Number(index)]}px`}
              onChange={index => {if (typeof index === 'number') change({bodySize: DOCUMENT_BODY_SIZES[index]});}} />
            <output>{style.bodySize}px</output>
          </div>
        </section>
        <section className="notebook-style-setting notebook-style-inline">
          <label>段间距</label>
          <Segmented variant="radio" value={style.paragraphSpacing} ariaLabel="段间距" disabled={!editable} options={[
            {value: 'normal', label: '常规'}, {value: 'loose', label: '宽松'},
          ]} onChange={value => change({paragraphSpacing: value as NotebookDocumentStyle['paragraphSpacing']})} />
        </section>
        <section className="notebook-style-setting notebook-style-inline">
          <label>行高</label>
          <Segmented variant="radio" value={String(style.lineHeight)} ariaLabel="行高" disabled={!editable} options={[
            {value: '1.5', label: '紧凑'}, {value: '1.74', label: '常规'}, {value: '2', label: '宽松'},
          ]} onChange={value => change({lineHeight: Number(value) as NotebookDocumentStyle['lineHeight']})} />
        </section>
        <Button variant="ghost" size="compact" disabled={!editable} onClick={() => change({...DEFAULT_DOCUMENT_STYLE})}>恢复默认样式</Button>
      </div>
    </aside>
  );
}
