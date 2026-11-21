/**
 * Shared plumbing for sandboxed blocks (static HTML blocks and React + Arco
 * component blocks).
 *
 * Both render user code inside an iframe without `allow-same-origin`, so the
 * block runs on an opaque origin: it can style and animate itself, but cannot
 * reach the host document, its storage or this editor's Lexical state. Height
 * travels back over `postMessage` from the block's own `ResizeObserver`.
 */

import * as React from 'react';

import Button from '../ui/Button';
import {DialogActions} from '../ui/Dialog';
import Modal from '../ui/Modal';

export const BLOCK_MIN_HEIGHT = 80;
export const BLOCK_MAX_HEIGHT = 1200;
export const BLOCK_DEFAULT_HEIGHT = 420;

type BlockTheme = {
  dark: boolean;
  background: string;
  foreground: string;
  border: string;
  fontFamily: string;
};

/** Resolved host tokens: an iframe cannot inherit the host's CSS variables. */
export function readBlockTheme(element: HTMLElement): BlockTheme {
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
    fontFamily: token('--notebook-font-family', '') || style?.fontFamily || 'system-ui, sans-serif',
  };
}

/** Follow appearance switches (and theme attribute flips) without a reload. */
export function useBlockTheme(anchor: React.RefObject<HTMLElement | null>): BlockTheme {
  const [theme, setTheme] = React.useState<BlockTheme>({
    dark: false,
    background: '#ffffff',
    foreground: '#20232a',
    border: '#e3e6ea',
    fontFamily: 'system-ui, sans-serif',
  });
  React.useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const doc = element.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        const next = readBlockTheme(element);
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
  }, [anchor]);
  return theme;
}

/** Auto height reported by the block's own `ResizeObserver`. */
export function useBlockHeight(frame: React.RefObject<HTMLIFrameElement | null>, initial?: number): number {
  const [height, setHeight] = React.useState(initial ?? BLOCK_DEFAULT_HEIGHT);
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: number };
      if (data?.type !== 'mica-block-height' || typeof data.height !== 'number') return;
      const next = Math.min(BLOCK_MAX_HEIGHT, Math.max(BLOCK_MIN_HEIGHT, Math.ceil(data.height)));
      setHeight((previous) => (previous === next ? previous : next));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  return height;
}

/**
 * Blocks run with scripts (the point of the block is interaction) but without
 * a same-origin grant, so `postMessage` is the only channel back to the host.
 * The block gets its own policy instead of inheriting the editor's: inline
 * styles/scripts and remote images work, while fetch/XHR/frames stay closed
 * so a block cannot exfiltrate what it renders.
 */
const BLOCK_POLICY =
  "default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net; connect-src https://esm.sh https://cdn.jsdelivr.net; frame-src https:; child-src https:; img-src data: blob: https:; font-src data: https: https://cdn.jsdelivr.net; media-src data: https:";

/**
 * Measured from the body box, not scrollHeight: scrollHeight never drops below
 * the current viewport, so a short block could only ever grow.
 * `documentElement` reports 0 for a srcdoc document, hence the body.
 */
function resizeScript(): string {
  return `<script>(function(){var send=function(){var b=document.body;var h=Math.ceil(b?b.getBoundingClientRect().height:0);if(!h)h=Math.ceil(document.documentElement.scrollHeight);parent.postMessage({type:'mica-block-height',height:h},'*')};try{new ResizeObserver(send).observe(document.body)}catch(e){}addEventListener('load',send);setTimeout(send,0);setTimeout(send,120);setTimeout(send,600);send()})()</script>`;
}

/**
 * Wrap a block's body in the shared shell: colour scheme, host typography and
 * the height reporter. `style` is appended last so a block type can override
 * the base box (the component block pads its own root, not the body), and
 * `head` carries what has to load before the body (a stylesheet, normally).
 * A dark block also carries `arco-theme="dark"` on its own body: Arco reads its
 * colour tokens from that attribute, and the iframe cannot inherit the host's.
 */
export function blockDocument(theme: BlockTheme, options: { body: string; style?: string; head?: string }): string {
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BLOCK_POLICY}">
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
${options.style ?? ''}
</style>
${options.head ?? ''}
<body${theme.dark ? ' arco-theme="dark"' : ''}>
${options.body}
${resizeScript()}
</body>`;
}

/** A user block is inlined into a module script: `</script` would end it early. */
export function escapeModuleSource(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1');
}

export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type SandboxBlockProps = Readonly<{
  /** The complete document handed to `srcdoc`. */
  document: string;
  /** Accessible name of the frame, e.g. 「HTML 块」. */
  frameTitle: string;
  /** Source shown in the overlay editor's save button label, e.g. 「编辑 HTML」. */
  editLabel: string;
  /** Current source (`html` or component code) the overlay starts from. */
  source: string;
  height?: number;
  onSave: (next: string) => void;
}>;

/**
 * The iframe plus the hover "edit" overlay both block types share: source is
 * edited in a modal independent of the preview height. Saving goes through
 * the node's own setter.
 */
export function SandboxBlock({
  document,
  frameTitle,
  editLabel,
  source,
  height,
  onSave,
}: SandboxBlockProps): React.JSX.Element {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const blockHeight = useBlockHeight(frameRef, height);
  const theme = useBlockTheme(wrapperRef);
  const [draft, setDraft] = React.useState<string | null>(null);
  const sourceId = React.useId();

  // Setting `srcdoc` during render leaves the first mount showing an empty
  // document once React re-mounts the node (StrictMode, node reuse): the
  // attribute is present but no navigation happens. Assigning it after mount
  // always navigates, so the block paints on the first frame.
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.setAttribute('srcdoc', document);
  }, [document]);

  const commit = () => {
    if (draft === null) return;
    onSave(draft);
    setDraft(null);
  };

  return (
    <div
      ref={wrapperRef}
      className="sandbox-block"
      style={{ position: 'relative', width: '100%' }}
    >
      <iframe
        ref={frameRef}
        title={frameTitle}
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        style={{
          boxSizing: 'border-box',
          width: '100%',
          height: blockHeight,
          border: `1px solid ${theme.border}`,
          borderRadius: 10,
          background: theme.background,
          display: 'block',
        }}
      />
      {draft === null ? (
        <Button
          small
          secondary
          className="sandbox-block-edit"
          onClick={() => setDraft(source)}
        >
          {editLabel}
        </Button>
      ) : null}
      {draft === null ? null : (
        <Modal
          title={editLabel}
          onClose={() => setDraft(null)}
          className="block-insert-modal block-source-modal"
          style={{width: 'min(760px, calc(100vw - 32px))'}}
        >
          <div className="block-insert-dialog">
            <div className="block-insert-source">
              <div className="block-insert-source-head">
                <label htmlFor={sourceId}>源码</label>
              </div>
              <textarea
                id={sourceId}
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                wrap="off"
              />
            </div>
            <DialogActions>
              <Button small secondary onClick={() => setDraft(null)}>取消</Button>
              <Button small onClick={commit}>保存</Button>
            </DialogActions>
          </div>
        </Modal>
      )}
    </div>
  );
}
