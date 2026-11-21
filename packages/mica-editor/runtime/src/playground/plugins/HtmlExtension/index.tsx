import {
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useId, useState} from 'react';

import {$createHtmlNode} from '../../nodes/HtmlNode';
import Button from '../../ui/Button';
import {DialogActions} from '../../ui/Dialog';
import FileInput from '../../ui/FileInput';
import TextInput from '../../ui/TextInput';
import {insertBlockNode} from '../insertBlock';

export type InsertHtmlPayload = Readonly<{
  html: string;
}>;

export const INSERT_HTML_COMMAND: LexicalCommand<InsertHtmlPayload> = createCommand('INSERT_HTML_COMMAND');

export const DEFAULT_HTML_BLOCK = `<section style="padding:20px;border:1px solid #d9d9d9;border-radius:12px;background:#fff;">
  <h3 style="margin:0 0 8px;">一个 HTML 页面</h3>
  <p style="margin:0;color:#666;">把结构、样式和交互放进这个独立块。</p>
</section>`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function pageEmbed(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const href = escapeAttribute(parsed.href);
    const host = escapeAttribute(parsed.host);
    // Deliberately no fixed colors: the card sits in the note and inherits its
    // foreground, so light and dark appearance both stay readable. Sites are
    // free to refuse framing (X-Frame-Options / frame-ancestors), which leaves
    // the frame blank — the bar keeps the address reachable in that case.
    return `<div style="width:100%;overflow:hidden;border:1px solid color-mix(in srgb, currentColor 16%, transparent);border-radius:10px;">
  <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;font-size:12px;line-height:1.6;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent);background:color-mix(in srgb, currentColor 4%, transparent);">
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.66;">${host}</span>
    <a href="${href}" target="_blank" rel="noopener noreferrer" style="flex:none;color:inherit;font-weight:500;text-decoration:none;">打开原网页 ↗</a>
  </div>
  <iframe src="${href}" title="${host}" referrerpolicy="no-referrer" sandbox="allow-forms allow-modals allow-popups allow-scripts" style="display:block;width:100%;height:520px;border:0;background:#fff;"></iframe>
  <p style="margin:0;padding:6px 10px;font-size:11px;line-height:1.6;opacity:.56;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);">此处空白说明该站点不允许被嵌入，请用上面的「打开原网页」查看。</p>
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
  insertBlockNode(editor, () => $createHtmlNode(payload.html));
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
  const [kind, setKind] = useState<'html' | 'url'>('html');
  const [source, setSource] = useState(DEFAULT_HTML_BLOCK);
  const [view, setView] = useState<'source' | 'preview'>('source');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const sourceId = useId();

  const insert = () => {
    const html = kind === 'url' ? pageEmbed(url) : source.trim();
    if (!html) {
      setError(kind === 'url' ? '请输入可嵌入的 http(s) 网页地址。' : '请输入 HTML 代码。');
      return;
    }
    const payload: InsertHtmlPayload = {html};
    if (onInsert) onInsert(payload);
    else insertHtmlBlock(activeEditor, payload);
    onClose();
  };

  const readFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setKind('html');
      setSource(normalizeLocalHtml(reader.result));
      setView('preview');
      setError('');
    };
    reader.onerror = () => setError('本地 HTML 文件读取失败。');
    reader.readAsText(file);
  };

  return (
    <div className="block-insert-dialog">
      <div className="block-insert-tabs" role="tablist" aria-label="HTML 来源">
        {(
          [
            ['html', 'HTML 源码'],
            ['url', '网页链接'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={kind === value ? 'block-insert-tab is-active' : 'block-insert-tab'}
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              setKind(value);
              setError('');
              setView('source');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'url' ? (
        <>
          <TextInput autoFocus label="网页地址" placeholder="https://example.com/page" value={url} onChange={setUrl} />
          <p className="block-insert-hint">
            网页以受限 iframe 显示。站点禁止被嵌入时（GitHub 一类很常见）块内会是空白，用块顶的「打开原网页」查看。
          </p>
        </>
      ) : (
        <>
          <FileInput
            label="从本地 HTML 导入"
            buttonLabel="选择 HTML 文件"
            accept=".html,.htm,text/html"
            onChange={readFile}
          />
          <div className="block-insert-source">
            <div className="block-insert-source-head">
              <label htmlFor={sourceId}>HTML 代码</label>
              <div className="block-insert-view-tabs" role="tablist" aria-label="HTML 查看方式">
                {(['source', 'preview'] as const).map(nextView => (
                  <button
                    type="button"
                    key={nextView}
                    className={view === nextView ? 'block-insert-view-tab is-active' : 'block-insert-view-tab'}
                    role="tab"
                    aria-selected={view === nextView}
                    onClick={() => setView(nextView)}
                  >
                    {nextView === 'source' ? '源码' : '预览'}
                  </button>
                ))}
              </div>
            </div>
            {view === 'preview' ? (
              <iframe
                className="block-insert-preview"
                title="HTML 预览"
                srcDoc={buildHtmlPreviewDocument(source)}
                sandbox=""
                referrerPolicy="no-referrer"
              />
            ) : (
              <textarea
                id={sourceId}
                autoFocus
                value={source}
                spellCheck={false}
                wrap="soft"
                onChange={event => setSource(event.target.value)}
                placeholder={DEFAULT_HTML_BLOCK}
              />
            )}
          </div>
          <p className="block-insert-hint">
            本地文件会把源码复制进笔记正文；原文件删除后，已插入的内容仍可打开。相对路径资源不会自动猜测。要写 React +
            Arco 交互模块，用「组件块」。
          </p>
        </>
      )}
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
          插入 HTML 块
        </Button>
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
