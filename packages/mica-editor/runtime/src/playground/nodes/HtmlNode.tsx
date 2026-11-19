/**
 * A block that renders user HTML inside a sandboxed iframe.
 *
 * The iframe never gets `allow-same-origin`, so scripts in the block run on an
 * opaque origin: they can style and animate themselves, but cannot reach the
 * host document, its storage or this editor's Lexical state. Height travels
 * back over `postMessage` from the block's own `ResizeObserver`.
 */

import type {JSX} from 'react';

import {BlockWithAlignableContents} from '@lexical/react/LexicalBlockWithAlignableContents';
import {
  DecoratorBlockNode,
  type SerializedDecoratorBlockNode,
} from '@lexical/react/LexicalDecoratorBlockNode';
import {
  $getDocument,
  $getNodeByKey,
  type DOMExportOutput,
  type EditorConfig,
  type ElementFormatType,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  numberValue,
  optional,
  type Spread,
  stringValue,
  withAccessors,
} from 'lexical';
import * as React from 'react';

export const HTML_NODE_MIN_HEIGHT = 80;
export const HTML_NODE_MAX_HEIGHT = 1200;
const DEFAULT_HEIGHT = 420;

const htmlNodeSchema = nodeSchema<HtmlNode>()({
  runtime: withAccessors(stringValue('html'), {getter: {field: '__runtime'}}),
  html: withAccessors(stringValue(), {getter: {field: '__html'}}),
  height: withAccessors(optional(numberValue()), {getter: 'getHeight'}),
});

export type HtmlBlockRuntime = 'html' | 'react';

/** Pinned so a note keeps rendering the same way when a new major ships. */
const REACT_VERSION = '18.3.1';
const ARCO_VERSION = '2.66.18';
const HTM_VERSION = '3.1.1';

type HtmlTheme = {
  dark: boolean;
  background: string;
  foreground: string;
  border: string;
  fontFamily: string;
};

/** Resolved host tokens: an iframe cannot inherit the host's CSS variables. */
function readHtmlTheme(element: HTMLElement): HtmlTheme {
  const doc = element.ownerDocument;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const root = doc.documentElement;
  const dark =
    root.dataset.appearance === 'dark' ||
    root.dataset.theme === 'dark' ||
    doc.body?.getAttribute('arco-theme') === 'dark';
  const style = win?.getComputedStyle(element);
  const token = (name: string, fallback: string) => {
    const value = style?.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    dark,
    background: token('--color-canvas', dark ? '#17191e' : '#ffffff'),
    foreground: token('--color-fg-strong', dark ? '#e8eaed' : '#20232a'),
    border: token('--color-line', dark ? '#515763' : '#e3e6ea'),
    fontFamily:
      token('--notebook-font-family', '') || style?.fontFamily || 'system-ui, sans-serif',
  };
}

/**
 * Blocks run with scripts (the point of the block is interaction) but without
 * a same-origin grant, so `postMessage` is the only channel back to the host.
 */
function buildDocument(html: string, theme: HtmlTheme, runtime: HtmlBlockRuntime): string {
  // Measured from the body box, not scrollHeight: scrollHeight never drops
  // below the current viewport, so a short block could only ever grow.
  // `documentElement` reports 0 for a srcdoc document, hence the body.
  const resize = `<script>(function(){var send=function(){var b=document.body;var h=Math.ceil(b?b.getBoundingClientRect().height:0);if(!h)h=Math.ceil(document.documentElement.scrollHeight);parent.postMessage({type:'mica-html-height',height:h},'*')};try{new ResizeObserver(send).observe(document.body)}catch(e){}addEventListener('load',send);setTimeout(send,0);setTimeout(send,120);setTimeout(send,600);send()})()</script>`;
  // The block gets its own policy instead of inheriting the editor's: inline
  // styles/scripts and remote images work, while fetch/XHR/frames stay closed
  // so a block cannot exfiltrate what it renders.
  const policy =
    "default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net; connect-src https://esm.sh https://cdn.jsdelivr.net; img-src data: blob: https:; font-src data: https: https://cdn.jsdelivr.net; media-src data: https:";
  if (runtime === 'react') {
    return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@arco-design/web-react@${ARCO_VERSION}/dist/css/arco.css">
<style>
  :root { color-scheme: ${theme.dark ? 'dark' : 'light'}; }
  html, body { margin: 0; padding: 0; background: ${theme.background}; color: ${theme.foreground}; font-family: ${theme.fontFamily}; }
  #root { padding: 14px; }
</style>
<div id="root"><div style="opacity:.55;font-size:13px">正在加载 React / Arco…</div></div>
<script type="module">
import React from 'https://esm.sh/react@${REACT_VERSION}';
import {createRoot} from 'https://esm.sh/react-dom@${REACT_VERSION}/client';
import * as Arco from 'https://esm.sh/@arco-design/web-react@${ARCO_VERSION}?deps=react@${REACT_VERSION},react-dom@${REACT_VERSION}';
import htm from 'https://esm.sh/htm@${HTM_VERSION}';
const html = htm.bind(React.createElement);
function showError(message) {
  const root = document.getElementById('root');
  root.innerHTML = '<pre style="color:#d4380d;white-space:pre-wrap;font:12.5px/1.6 ui-monospace,monospace"></pre>';
  root.querySelector('pre').textContent = String(message);
}
try {
${escapeModuleSource(html)}
  const component = typeof App === 'function' ? App : null;
  if (!component) throw new Error('react 块需要定义 function App(props) { ... }');
  createRoot(document.getElementById('root')).render(html\`<\${component} React=\${React} Arco=\${Arco} html=\${html} />\`);
} catch (error) {
  showError((error && error.stack) || error);
}
</script>
${resize}`;
  }
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style>
  :root { color-scheme: ${theme.dark ? 'dark' : 'light'}; }
  html, body { margin: 0; padding: 0; }
  body {
    box-sizing: border-box;
    padding: 14px;
    background: ${theme.background};
    color: ${theme.foreground};
    font-family: ${theme.fontFamily};
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
</style>
${html}
${resize}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A user block is inlined into a module script: `</script` would end it early. */
function escapeModuleSource(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1');
}

type HtmlComponentProps = Readonly<{
  className: Readonly<{base: string; focus: string}>;
  format: ElementFormatType | null;
  nodeKey: NodeKey;
  editor: LexicalEditor;
  html: string;
  runtime: HtmlBlockRuntime;
  height?: number;
}>;

function HtmlComponent({className, format, nodeKey, editor, html, runtime, height}: HtmlComponentProps) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [autoHeight, setAutoHeight] = React.useState(height ?? DEFAULT_HEIGHT);
  const [theme, setTheme] = React.useState<HtmlTheme>({
    dark: false,
    background: '#ffffff',
    foreground: '#20232a',
    border: '#e3e6ea',
    fontFamily: 'system-ui, sans-serif',
  });
  const [draft, setDraft] = React.useState<string | null>(null);
  const [hovering, setHovering] = React.useState(false);

  React.useEffect(() => {
    const anchor = wrapperRef.current;
    if (!anchor) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        const next = readHtmlTheme(anchor);
        setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      });
    };
    const observer = new win.MutationObserver(refresh);
    const options = {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-appearance', 'data-theme', 'arco-theme'],
    };
    observer.observe(doc.documentElement, options);
    if (doc.body) observer.observe(doc.body, options);
    refresh();
    return () => {
      observer.disconnect();
      win.cancelAnimationFrame(frame);
    };
  }, []);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as {type?: string; height?: number};
      if (data?.type !== 'mica-html-height' || typeof data.height !== 'number') return;
      const next = Math.min(HTML_NODE_MAX_HEIGHT, Math.max(HTML_NODE_MIN_HEIGHT, Math.ceil(data.height)));
      setAutoHeight((previous) => (previous === next ? previous : next));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const source = React.useMemo(() => buildDocument(html, theme, runtime), [html, runtime, theme]);

  // Setting `srcdoc` during render leaves the first mount showing an empty
  // document once React re-mounts the node (StrictMode, node reuse): the
  // attribute is present but no navigation happens. Assigning it after mount
  // always navigates, so the block paints on the first frame.
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.setAttribute('srcdoc', source);
  }, [source]);
  const commit = () => {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node instanceof HtmlNode) node.setHtml(next);
    });
  };

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div
        ref={wrapperRef}
        style={{position: 'relative', width: '100%'}}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <iframe
          ref={frameRef}
          title="HTML 块"
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          style={{
            width: '100%',
            height: autoHeight,
            border: `1px solid ${theme.border}`,
            borderRadius: 10,
            background: theme.background,
            display: 'block',
          }}
        />
        {hovering && draft === null ? (
          <button
            type="button"
            onClick={() => setDraft(html)}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              padding: '2px 10px',
              fontSize: 12,
              lineHeight: '20px',
              borderRadius: 6,
              border: `1px solid ${theme.border}`,
              background: theme.background,
              color: theme.foreground,
              cursor: 'pointer',
              opacity: 0.92,
            }}
          >
            编辑 HTML
          </button>
        ) : null}
        {draft === null ? null : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${theme.border}`,
              background: theme.background,
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              style={{
                flex: 1,
                minHeight: 160,
                resize: 'none',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12.5,
                lineHeight: 1.6,
                color: theme.foreground,
                background: theme.background,
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                padding: 10,
              }}
            />
            <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
              <button
                type="button"
                onClick={() => setDraft(null)}
                style={{
                  padding: '4px 14px',
                  fontSize: 12.5,
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: 'transparent',
                  color: theme.foreground,
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={commit}
                style={{
                  padding: '4px 14px',
                  fontSize: 12.5,
                  borderRadius: 6,
                  border: '1px solid transparent',
                  background: '#4269c2',
                  color: '#ffffff',
                  cursor: 'pointer',
                }}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>
    </BlockWithAlignableContents>
  );
}

export type SerializedHtmlNode = Spread<
  {
    html: string;
    runtime?: HtmlBlockRuntime;
    height?: number;
  },
  SerializedDecoratorBlockNode
>;

export class HtmlNode extends DecoratorBlockNode {
  __html: string;
  __runtime: HtmlBlockRuntime;
  __height?: number;

  $config() {
    return this.config('html', {
      extends: DecoratorBlockNode,
      json: htmlNodeSchema,
    });
  }

  static clone(node: HtmlNode): HtmlNode {
    return new HtmlNode(node.__html, node.__runtime, node.__height, node.__format, node.__key);
  }

  constructor(
    html: string = '',
    runtime: HtmlBlockRuntime = 'html',
    height?: number,
    format?: ElementFormatType,
    key?: NodeKey,
  ) {
    super(format, key);
    this.__html = html;
    this.__runtime = runtime;
    this.__height = height;
  }

  getHtml(): string {
    return this.getLatest().__html;
  }

  setHtml(html: string): this {
    const self = this.getWritable();
    self.__html = html;
    return self;
  }

  getRuntime(): HtmlBlockRuntime {
    return this.getLatest().__runtime;
  }

  setRuntime(runtime: HtmlBlockRuntime): this {
    const self = this.getWritable();
    self.__runtime = runtime;
    return self;
  }

  getHeight(): number | undefined {
    return this.getLatest().__height;
  }

  setHeight(height: number | undefined): this {
    const self = this.getWritable();
    self.__height = height;
    return self;
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('div');
    element.setAttribute('data-lexical-html-block', 'true');
    element.textContent = this.__html;
    return {element};
  }

  updateDOM(): false {
    return false;
  }

  getTextContent(): string {
    return stripTags(this.__html);
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    return (
      <HtmlComponent
        className={{
          base: embedBlockTheme.base || '',
          focus: embedBlockTheme.focus || '',
        }}
        editor={editor}
        format={this.__format}
        height={this.__height}
        html={this.__html}
        nodeKey={this.getKey()}
        runtime={this.__runtime}
      />
    );
  }
}

export function $createHtmlNode(html: string, runtime: HtmlBlockRuntime = 'html', height?: number): HtmlNode {
  return new HtmlNode(html, runtime, height);
}

export function $isHtmlNode(node: HtmlNode | LexicalNode | null | undefined): node is HtmlNode {
  return node instanceof HtmlNode;
}
