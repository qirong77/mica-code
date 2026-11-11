import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createMarkdownBridge, type MarkdownEditorStatus } from './bridge.js';
import { readEditorTheme } from './theme.js';
import './MarkdownEditor.css';

export type MarkdownEditorProps = {
  value: string;
  onChange(value: string): void;
  documentId: string;
  readOnly?: boolean;
  ariaLabel?: string;
};

export type MarkdownEditorHandle = {
  /** Wait for hydration, collect pending input, and synchronously notify onChange before resolving. */
  flush(): Promise<string>;
};

/** A lightweight host; the isolated runtime is the only module that imports Lexical/CDN React. */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createMarkdownBridge> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(''));
  const [status, setStatus] = useState<MarkdownEditorStatus>('loading');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState(props.value);

  useImperativeHandle(ref, () => ({
    flush: () => bridge.current?.flush() ?? Promise.resolve(latest.current.value),
  }), []);

  useLayoutEffect(() => {
    const instance = createMarkdownBridge({
      token,
      target: () => iframe.current?.contentWindow ?? null,
      onChange(documentId, value) {
        if (documentId !== latest.current.documentId || latest.current.readOnly) return;
        setSource(value);
        latest.current.onChange(value);
      },
      onStatus(next, text) {
        setStatus(next);
        setMessage(text ?? '');
      },
      onReady: syncTheme,
    });
    bridge.current = instance;
    instance.setDocument({
      documentId: latest.current.documentId,
      value: latest.current.value,
      readOnly: latest.current.readOnly ?? false,
    });
    function syncTheme() {
      if (!container.current) return;
      const theme = readEditorTheme(container.current);
      instance.theme(theme.appearance, theme.tokens);
    }
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme', 'data-appearance', 'class', 'style'],
    });
    window.addEventListener('message', instance.receive);
    return () => {
      window.removeEventListener('message', instance.receive);
      observer.disconnect();
      instance.dispose();
      bridge.current = null;
    };
  }, [token]);

  useLayoutEffect(() => {
    bridge.current?.setDocument({
      documentId: props.documentId, value: props.value, readOnly: props.readOnly ?? false,
    });
    setSource(bridge.current?.getValue() ?? props.value);
  }, [props.documentId, props.value, props.readOnly]);

  const label = props.ariaLabel ?? 'Markdown 编辑器';
  return (
    <div className="mica-markdown-editor" ref={container} aria-busy={status === 'loading'}>
      {status === 'fallback' ? (
        <>
          <p className="mica-markdown-editor-notice" role="status">{message} 可继续在此编辑源码。</p>
          <textarea
            className="mica-markdown-editor-source"
            aria-label={label}
            value={source}
            readOnly={props.readOnly}
            spellCheck={false}
            onChange={(event) => bridge.current?.editSource(event.currentTarget.value)}
          />
        </>
      ) : (
        <>
          {status === 'loading' ? <p className="mica-markdown-editor-notice" role="status">正在加载 Markdown 编辑器…</p> : null}
          <iframe
            ref={iframe}
            title={label}
            src={`/editor/index.html?mode=markdown#${token}`}
            sandbox="allow-scripts allow-popups"
            allow="clipboard-read; clipboard-write"
            onError={() => bridge.current?.fail('编辑器加载失败，已保留 Markdown 源码。')}
          />
        </>
      )}
    </div>
  );
});
