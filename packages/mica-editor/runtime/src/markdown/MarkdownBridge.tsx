import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {applyNotebookTheme} from '../workspace/theme';

const CHANNEL = 'mica-markdown';
const token = decodeURIComponent(location.hash.slice(1));
const post = (message: Record<string, unknown>) => window.parent.postMessage({channel: CHANNEL, token, ...message}, '*');
let sequence = 0;

export class MarkdownSession {
  readonly mountKey = ++sequence;
  readonly initialValue: string;
  value: string;
  reader: (() => string) | null = null;
  setReadOnly: ((readOnly: boolean) => void) | null = null;
  constructor(readonly documentId: string, value: string, public readOnly: boolean, readonly requestId?: string) {
    this.value = this.initialValue = value;
  }
  change = (value: string) => {
    if (this.readOnly || value === this.value) return;
    this.value = value;
    post({type: 'change', documentId: this.documentId, value});
  };
  snapshot() { return this.reader?.() ?? this.value; }
  ready() { post({type: 'loaded', documentId: this.documentId, requestId: this.requestId}); }
}

const Context = createContext<MarkdownSession | null>(null);
export const useMarkdownSession = () => useContext(Context)!;

export function MarkdownFrame({children}: {children: ReactNode}) {
  const [session, setSession] = useState<MarkdownSession | null>(null);
  const current = useRef<MarkdownSession | null>(null);
  useEffect(() => {
    document.body.classList.add('mica-arco-theme');
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window.parent || !message || message.channel !== CHANNEL || message.token !== token) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
      try {
        if (message.type === 'theme') applyNotebookTheme(message.appearance, message.tokens);
        else if (message.type === 'load') {
          if (typeof message.documentId !== 'string' || typeof message.value !== 'string' || typeof message.readOnly !== 'boolean') throw new Error('Markdown 文档格式无效');
          const next = new MarkdownSession(message.documentId, message.value, message.readOnly, requestId);
          current.current = next;
          setSession(next);
        } else if (message.type === 'flush') {
          if (!current.current) throw new Error('Markdown 编辑器尚未就绪');
          post({type: 'result', requestId, documentId: current.current.documentId, value: current.current.snapshot()});
        } else if (message.type === 'editable' && typeof message.readOnly === 'boolean' && current.current) {
          current.current.readOnly = message.readOnly;
          current.current.setReadOnly?.(message.readOnly);
        }
      } catch (cause) {
        post({type: 'error', requestId, documentId: current.current?.documentId, message: cause instanceof Error ? cause.message : String(cause)});
      }
    };
    window.addEventListener('message', receive);
    post({type: 'ready'});
    return () => window.removeEventListener('message', receive);
  }, []);
  return session ? <Context.Provider key={session.mountKey} value={session}>{children}</Context.Provider> : <div className="notebook-loading" role="status">正在载入 Markdown…</div>;
}
