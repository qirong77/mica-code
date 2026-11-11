import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createMarkdownBridge, type MarkdownEditorStatus } from './bridge.js';
import { readEditorTheme } from './theme.js';
import { applyMarkdownSourceEdit, planMarkdownSourceIndent } from '../sourceEditing.js';
import './MarkdownEditor.css';

export type MarkdownEditorProps = {
  value: string;
  onChange(value: string): void;
  onSave?(value: string): void;
  documentId: string;
  readOnly?: boolean;
  ariaLabel?: string;
};

export type MarkdownEditorHandle = {
  /** Wait for hydration, collect pending input, and synchronously notify onChange before resolving. */
  flush(): Promise<string>;
  /**
   * 最近一次交给宿主的 Markdown 文本，同步返回。保存、切换和关闭前应先 await flush()，
   * 再改变 documentId 或卸载；缓存可能还不包含编辑器尚未提交的输入。
   */
  getValue(): string;
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
    getValue: () => bridge.current?.getValue() ?? latest.current.value,
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
      onSave(documentId, value) {
        if (documentId !== latest.current.documentId || latest.current.readOnly) return;
        latest.current.onSave?.(value);
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
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !props.readOnly) {
                event.preventDefault();
                const element = event.currentTarget;
                const edit = planMarkdownSourceIndent(element.value, element.selectionStart, element.selectionEnd, event.shiftKey);
                if (edit) applyMarkdownSourceEdit(element, edit, (value) => bridge.current?.editSource(value));
                return;
              }
              if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return;
              event.preventDefault();
              event.stopPropagation();
              if (!props.readOnly) {
                bridge.current?.editSource(event.currentTarget.value);
                latest.current.onSave?.(bridge.current?.getValue() ?? event.currentTarget.value);
              }
            }}
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
