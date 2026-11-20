import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useState} from 'react';

import {$createHtmlNode, type HtmlBlockRuntime} from '../../nodes/HtmlNode';
import Button from '../../ui/Button';
import {DialogActions} from '../../ui/Dialog';
import FileInput from '../../ui/FileInput';
import TextInput from '../../ui/TextInput';
import {$insertSlotHostAtRoot} from '../../nodes/slotHostEscape';
import {Select} from '@arco-design/web-react';

export type InsertHtmlPayload = Readonly<{
  html: string;
  runtime?: HtmlBlockRuntime;
}>;

export const INSERT_HTML_COMMAND: LexicalCommand<InsertHtmlPayload> =
  createCommand('INSERT_HTML_COMMAND');

export const DEFAULT_HTML_BLOCK = `<section style="padding:20px;border:1px solid #d9d9d9;border-radius:12px;background:#fff;">
  <h3 style="margin:0 0 8px;">一个 HTML 页面</h3>
  <p style="margin:0;color:#666;">把结构、样式和交互放进这个独立块。</p>
</section>`;

export const DEFAULT_REACT_BLOCK = `function App({React, Arco, html}) {
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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageEmbed(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const href = escapeAttribute(parsed.href);
    return `<div style="width:100%;min-height:520px;overflow:hidden;border:1px solid #d9d9d9;border-radius:10px;">
  <iframe src="${href}" title="嵌入网页" referrerpolicy="no-referrer" sandbox="allow-forms allow-modals allow-popups allow-scripts" style="display:block;width:100%;height:520px;border:0;background:#fff;"></iframe>
</div>`;
  } catch {
    return null;
  }
}

/**
 * A complete local HTML document is not nested inside the block's srcdoc. Keep
 * its inline styles and body, which also makes the selected file independent of
 * the original path. Relative images/styles are intentionally not guessed: the
 * source itself is persisted in the notebook document and remains recoverable.
 */
export function normalizeLocalHtml(value: string): string {
  if (typeof DOMParser === 'undefined' || !/<(?:!doctype|html|head|body)\b/i.test(value)) return value;
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  const styles = [...parsed.head.querySelectorAll('style, link[rel="stylesheet"]')]
    .map(node => node.outerHTML)
    .join('\n');
  const body = parsed.body?.innerHTML || value;
  return `${styles}\n${body}`.trim();
}

/** Render a source fragment in the same isolated shape used by the inserted block. */
export function buildHtmlPreviewDocument(value: string): string {
  const source = value.trim();
  if (/<(?:!doctype|html)\b/i.test(source)) return source;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0}body{box-sizing:border-box;padding:14px;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}</style></head><body>${source}</body></html>`;
}

export function insertHtmlBlock(editor: LexicalEditor, payload: InsertHtmlPayload): void {
  editor.update(() => {
    const selection = $getSelection();
    const node = $createHtmlNode(payload.html, payload.runtime ?? 'html');
    if (!$isRangeSelection(selection)) {
      const paragraph = $createParagraphNode();
      $getRoot().append(node, paragraph);
      paragraph.selectStart();
      return;
    }
    $insertSlotHostAtRoot(node);
    const next = node.getNextSibling();
    const paragraph = $isParagraphNode(next) ? next : $createParagraphNode();
    if (paragraph.getParent() === null) node.insertAfter(paragraph);
    paragraph.selectStart();
  }, {discrete: true});
}

function InsertHtmlDialog({
  activeEditor,
  onClose,
  onInsert,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
  onInsert?: (payload: InsertHtmlPayload) => void;
}): JSX.Element {
  const [kind, setKind] = useState<'react' | 'html' | 'url'>('react');
  const [runtime, setRuntime] = useState<HtmlBlockRuntime>('react');
  const [source, setSource] = useState(DEFAULT_REACT_BLOCK);
  const [view, setView] = useState<'source' | 'preview'>('source');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const insert = () => {
    const html = kind === 'url' ? pageEmbed(url) : source.trim();
    if (!html) {
      setError(kind === 'url' ? '请输入可嵌入的 http(s) 网页地址。' : '请输入 HTML 或 React 代码。');
      return;
    }
    const payload: InsertHtmlPayload = {html, runtime: kind === 'url' ? 'html' : runtime};
    if (onInsert) onInsert(payload);
    else insertHtmlBlock(activeEditor, payload);
    onClose();
  };

  const selectKind = (next: 'react' | 'html' | 'url') => {
    setKind(next);
    setError('');
    setView('source');
    if (next === 'react') {
      setRuntime('react');
      if (!source.trim() || source === DEFAULT_HTML_BLOCK) setSource(DEFAULT_REACT_BLOCK);
    }
    if (next === 'html') {
      setRuntime('html');
      if (!source.trim() || source === DEFAULT_REACT_BLOCK) setSource(DEFAULT_HTML_BLOCK);
    }
  };

  const readFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setKind('html');
      setRuntime('html');
      setSource(normalizeLocalHtml(reader.result));
      setView('preview');
      setError('');
    };
    reader.onerror = () => setError('本地 HTML 文件读取失败。');
    reader.readAsText(file);
  };

  return (
    <div className="html-insert-dialog">
      <div className="html-insert-tabs" role="tablist" aria-label="HTML 来源">
        {([
          ['react', '快速创建'],
          ['html', 'HTML 源码'],
          ['url', '网页链接'],
        ] as const).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={kind === value ? 'html-insert-tab is-active' : 'html-insert-tab'}
            role="tab"
            aria-selected={kind === value}
            onClick={() => selectKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'url' ? (
        <TextInput
          autoFocus
          label="网页地址"
          placeholder="https://example.com/page"
          value={url}
          onChange={setUrl}
        />
      ) : (
        <>
          <div className="html-insert-runtime">
            <label htmlFor="html-insert-runtime">渲染方式</label>
            <Select
              id="html-insert-runtime"
              value={runtime}
              onChange={value => setRuntime(value as HtmlBlockRuntime)}
              options={[
                {value: 'react', label: 'React + Arco（适合快速原型）'},
                {value: 'html', label: 'HTML + CSS（静态结构）'},
              ]}
            />
          </div>
          <FileInput
            label="从本地 HTML 导入"
            buttonLabel="选择 HTML 文件"
            accept=".html,.htm,text/html"
            onChange={readFile}
          />
          {runtime === 'html' && (
            <div className="html-insert-view-tabs" role="tablist" aria-label="HTML 查看方式">
              {(['source', 'preview'] as const).map((nextView) => (
                <button
                  type="button"
                  key={nextView}
                  className={view === nextView ? 'html-insert-view-tab is-active' : 'html-insert-view-tab'}
                  role="tab"
                  aria-selected={view === nextView}
                  onClick={() => setView(nextView)}
                >
                  {nextView === 'source' ? '源码' : '预览'}
                </button>
              ))}
            </div>
          )}
          {runtime === 'html' && view === 'preview' ? (
            <iframe
              className="html-insert-preview"
              title="HTML 预览"
              srcDoc={buildHtmlPreviewDocument(source)}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <label className="html-insert-source">
              {runtime === 'react' ? 'React 代码' : 'HTML 代码'}
              <textarea
                autoFocus
                value={source}
                spellCheck={false}
                wrap="soft"
                onChange={event => setSource(event.target.value)}
                placeholder={runtime === 'react' ? DEFAULT_REACT_BLOCK : DEFAULT_HTML_BLOCK}
              />
            </label>
          )}
          <p className="html-insert-hint">本地文件会把源码复制进笔记正文；原文件删除后，已插入的内容仍可打开。相对路径资源不会自动猜测。</p>
        </>
      )}
      {error && <p className="html-insert-error" role="alert">{error}</p>}
      <DialogActions>
        <Button small onClick={onClose}>取消</Button>
        <Button small onClick={insert}>插入 HTML 块</Button>
      </DialogActions>
    </div>
  );
}

export {InsertHtmlDialog};

export const HtmlExtension = defineExtension({
  name: '@mica/editor/Html',
  register: editor =>
    editor.registerCommand(
      INSERT_HTML_COMMAND,
      payload => {
        insertHtmlBlock(editor, payload);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

