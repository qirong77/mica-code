import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {type LexicalEditor} from 'lexical';
import {Component, createContext, type ReactNode, useContext, useEffect, useRef, useState} from 'react';

import NotebookOutline, {type NotebookNavigation, type NotebookOutlineSnapshot} from './NotebookOutline';
import {applyNotebookBarInsets, applyNotebookTheme} from './theme';
import {isNotebookAction, NOTEBOOK_ACTION_COMMAND, type NotebookAction} from './notebookActions';

export interface NotebookDocument {
  version: 1;
  editorState: string | null;
}

const CHANNEL = 'mica-notebook';
// The sandbox has an opaque origin: authenticate the parent WindowProxy + nonce,
// never event.origin. The host supplies a fresh UUID in the raw hash.
const token = decodeURIComponent(window.location.hash.slice(1));
const post = (message: Record<string, unknown>) =>
  window.parent.postMessage({channel: CHANNEL, token, ...message}, '*');
let mountSequence = 0;

export class NotebookSession {
  readonly mountKey: string;
  editor: LexicalEditor | null = null;
  nestedEditors = new Set<LexicalEditor>();
  private queued = false;
  private active = true;
  private loaded = false;
  private frozen = false;
  private presenting = false;
  private frozenBeforeEditable: boolean | null = null;
  private navigateOutline: ((navigation: NotebookNavigation) => void) | null = null;

  constructor(
    readonly noteId: string,
    readonly document: NotebookDocument,
    readonly requestId?: string,
  ) {
    this.mountKey = `${noteId}:${++mountSequence}`;
  }

  performAction(action: NotebookAction): void {
    if (this.active && !this.frozen && this.editor) {
      this.editor.dispatchCommand(NOTEBOOK_ACTION_COMMAND, action);
    }
  }

  private restoreEditor(editor: LexicalEditor): void {
    const editable = this.frozenBeforeEditable;
    if (editable === null) return;
    this.frozenBeforeEditable = null;
    if (editor.isEditable() !== editable) editor.setEditable(editable);
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    this.syncEditability();
  }

  setPresenting(presenting: boolean): void {
    this.presenting = presenting;
    this.syncEditability();
  }

  private syncEditability(): void {
    if (!this.editor) return;
    if (this.frozen || this.presenting) {
      // Repeated freezes must not replace the user's pre-existing read-only
      // state. Nested composers keep their own parent editability binding;
      // DOM/input guards also cover captions and native inputs.
      if (this.frozenBeforeEditable === null) this.frozenBeforeEditable = this.editor.isEditable();
      if (this.editor.isEditable()) this.editor.setEditable(false);
    } else {
      // Only editability changes: no editor-state replacement or history clear.
      this.restoreEditor(this.editor);
    }
  }

  snapshot(): NotebookDocument {
    if (!this.editor) throw new Error('编辑器尚未就绪，请稍后再试');
    // Commit any pending edit (including captions) before serializing.
    for (const nested of this.nestedEditors) nested.update(() => {}, {discrete: true});
    this.editor.update(() => {}, {discrete: true});
    return {
      version: 1,
      editorState: JSON.stringify(this.editor.getEditorState().toJSON()),
    };
  }

  attach(editor: LexicalEditor): () => void {
    this.editor = editor;
    this.active = true;
    this.syncEditability();
    queueMicrotask(() => {
      if (this.active && !this.loaded) {
        this.loaded = true;
        post({type: 'loaded', noteId: this.noteId, requestId: this.requestId, loadId: this.requestId});
      }
    });
    return () => { this.active = false; this.editor = null; this.restoreEditor(editor); };
  }

  attachNested(editor: LexicalEditor): () => void {
    this.nestedEditors.add(editor);
    return () => { this.nestedEditors.delete(editor); };
  }

  publishOutline(snapshot: NotebookOutlineSnapshot): boolean {
    if (!this.active || !this.editor) return false;
    post({type: 'outline', noteId: this.noteId, loadId: this.requestId, ...snapshot});
    return true;
  }

  bindNavigation(navigate: (navigation: NotebookNavigation) => void): () => void {
    this.navigateOutline = navigate;
    return () => { if (this.navigateOutline === navigate) this.navigateOutline = null; };
  }

  navigate(navigation: NotebookNavigation): void {
    if (this.active && this.editor) this.navigateOutline?.(navigation);
  }

  dirty = () => {
    if (this.queued || !this.active) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.active || !this.loaded) return;
      try { post({type: 'change', noteId: this.noteId, loadId: this.requestId, document: this.snapshot()}); }
      catch (error) { post({type: 'error', loadId: this.requestId, noteId: this.noteId, message: String(error)}); }
    });
  };
}

const Context = createContext<NotebookSession | null>(null);
export const useNotebookSession = () => useContext(Context);

class DocumentBoundary extends Component<{session: NotebookSession; children: ReactNode}, {error: string | null}> {
  state = {error: null as string | null};
  static getDerivedStateFromError(error: unknown) { return {error: String(error)}; }
  componentDidCatch(error: unknown) {
    post({type: 'error', requestId: this.props.session.requestId, loadId: this.props.session.requestId, noteId: this.props.session.noteId, message: String(error)});
  }
  render() {
    return this.state.error ? <div className="notebook-loading" role="alert">无法打开这篇笔记：{this.state.error}</div> : this.props.children;
  }
}

export function useNotebookNestedEditor(nested: LexicalEditor): void {
  const session = useNotebookSession();
  useEffect(() => {
    if (!session) return;
    const detach = session.attachNested(nested);
    const unregister = nested.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      if (dirtyElements.size || dirtyLeaves.size) session.dirty();
    });
    return () => { unregister(); detach(); };
  }, [nested, session]);
}

export function NotebookFrame({children}: {children: ReactNode}) {
  const [session, setSession] = useState<NotebookSession | null>(null);
  const current = useRef<NotebookSession | null>(null);
  const frozen = useRef(false);
  useEffect(() => {
    document.body.classList.add('mica-arco-theme');
    document.documentElement.dataset.frozen = String(frozen.current);
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window.parent || !message || message.channel !== CHANNEL || message.token !== token) return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
      if (message.type === 'theme') {
        applyNotebookTheme(message.appearance, message.tokens);
      } else if (message.type === 'layout') {
        applyNotebookBarInsets(message);
      } else if (message.type === 'freeze' && typeof message.frozen === 'boolean') {
        frozen.current = message.frozen;
        document.documentElement.dataset.frozen = String(message.frozen);
        current.current?.setFrozen(message.frozen);
      } else if (message.type === 'action') {
        const active = current.current;
        if (active && message.noteId === active.noteId && message.loadId === active.requestId && isNotebookAction(message.action)) {
          active.performAction(message.action);
        }
      } else if (message.type === 'navigate') {
        const active = current.current;
        if (!active || message.noteId !== active.noteId || message.loadId !== active.requestId) return;
        if (typeof message.heading === 'string') active.navigate({heading: message.heading});
        else if (['top', 'table', 'code', 'mermaid', 'image'].includes(message.block)) active.navigate({block: message.block});
      } else if (message.type === 'load') {
        try {
          const doc = message.document;
          if (!requestId || message.loadId !== requestId || typeof message.noteId !== 'string' || !doc || doc.version !== 1 ||
              (doc.editorState !== null && typeof doc.editorState !== 'string')) throw new Error('笔记文档格式无效');
          if (doc.editorState !== null) {
            const parsed = JSON.parse(doc.editorState);
            if (parsed?.root?.type !== 'root' || !Array.isArray(parsed.root.children)) throw new Error('笔记正文格式无效');
          }
          const next = new NotebookSession(message.noteId, doc, requestId);
          next.setFrozen(frozen.current);
          current.current = next;
          setSession(next);
        } catch (error) {
          post({type: 'error', requestId, loadId: requestId, noteId: message.noteId, message: String(error)});
        }
      } else if (message.type === 'flush') {
        try {
          if (!current.current) throw new Error('尚未载入笔记');
          if (message.loadId !== current.current.requestId || message.noteId !== current.current.noteId) throw new Error('笔记已切换，请重试');
          post({type: 'result', requestId, loadId: current.current.requestId, noteId: current.current.noteId, document: current.current.snapshot(), ok: true});
        } catch (error) {
          // The host rejects this request, leaving the current note mounted.
          post({type: 'error', requestId, loadId: message.loadId, noteId: current.current?.noteId, message: String(error)});
        }
      }
    };
    // Portalled menus and native inputs do not all consult Lexical editability.
    // CSS handles pointer hit-testing; capture also blocks already-focused
    // controls / keyboard shortcuts without blurring or resetting selection.
    const stopFrozenInput = (event: Event) => {
      if (!frozen.current) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const inputEvents = ['keydown', 'keypress', 'keyup', 'beforeinput', 'paste', 'cut', 'drop', 'compositionstart', 'click', 'pointerdown', 'pointerup', 'contextmenu'];
    for (const type of inputEvents) window.addEventListener(type, stopFrozenInput, true);
    window.addEventListener('message', receive);
    post({type: 'ready'});
    return () => {
      window.removeEventListener('message', receive);
      for (const type of inputEvents) window.removeEventListener(type, stopFrozenInput, true);
    };
  }, []);
  return session
    ? <Context.Provider key={session.mountKey} value={session}><DocumentBoundary session={session}>{children}</DocumentBoundary></Context.Provider>
    : <div className="notebook-loading" role="status">正在载入笔记…</div>;
}

export function NotebookEditorBinding() {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  useEffect(() => session?.attach(editor), [editor, session]);
  return session ? <NotebookOutline session={session} /> : null;
}
