import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {type LexicalEditor} from 'lexical';
import {Component, createContext, type ReactNode, useContext, useEffect, useRef, useState} from 'react';

import {type Comments, type CommentStore} from '../playground/commenting';
import NotebookOutline, {type NotebookNavigation, type NotebookOutlineSnapshot} from './NotebookOutline';
import {applyNotebookTheme} from './theme';

export interface NotebookDocument {
  version: 1;
  editorState: string | null;
  comments: unknown[];
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
  commentStore: CommentStore | null = null;
  nestedEditors = new Set<LexicalEditor>();
  private queued = false;
  private active = true;
  private loaded = false;
  private frozen = false;
  private frozenBeforeEditable: boolean | null = null;
  private navigateOutline: ((navigation: NotebookNavigation) => void) | null = null;

  constructor(
    readonly noteId: string,
    readonly document: NotebookDocument,
    readonly requestId?: string,
  ) { this.mountKey = `${noteId}:${++mountSequence}`; }

  private restoreEditor(editor: LexicalEditor): void {
    const editable = this.frozenBeforeEditable;
    if (editable === null) return;
    this.frozenBeforeEditable = null;
    if (editor.isEditable() !== editable) editor.setEditable(editable);
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (!this.editor) return;
    if (frozen) {
      // Repeated freezes must not replace the user's pre-existing read-only
      // state. Nested composers keep their own parent editability binding;
      // DOM/input guards also cover captions, comments and native inputs.
      if (this.frozenBeforeEditable === null) this.frozenBeforeEditable = this.editor.isEditable();
      if (this.editor.isEditable()) this.editor.setEditable(false);
    } else {
      // Only editability changes: no editor-state replacement or history clear.
      this.restoreEditor(this.editor);
    }
  }

  snapshot(): NotebookDocument {
    if (!this.editor) throw new Error('编辑器尚未就绪，请稍后再试');
    const root = this.editor.getRootElement();
    if (root?.dataset.sourcePending === 'true' ||
        (root?.dataset.sourceMode && root.dataset.sourceMode !== 'wysiwyg')) {
      throw new Error('请先返回富文本模式，再保存或切换笔记。源码内容尚未保存。');
    }
    // Commit any pending edit (including captions) before serializing.
    for (const nested of this.nestedEditors) nested.update(() => {}, {discrete: true});
    this.editor.update(() => {}, {discrete: true});
    return {
      version: 1,
      editorState: JSON.stringify(this.editor.getEditorState().toJSON()),
      comments: structuredClone(this.commentStore?.getComments() ?? this.document.comments),
    };
  }

  attach(editor: LexicalEditor): () => void {
    this.editor = editor;
    this.active = true;
    if (this.frozen) this.setFrozen(true);
    queueMicrotask(() => {
      if (this.active && !this.loaded) {
        this.loaded = true;
        post({type: 'loaded', noteId: this.noteId, requestId: this.requestId});
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
    post({type: 'outline', noteId: this.noteId, ...snapshot});
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
      try { post({type: 'change', noteId: this.noteId, document: this.snapshot()}); }
      catch { /* Source mode is deliberately not persisted. Flush reports why. */ }
    });
  };
}

const Context = createContext<NotebookSession | null>(null);
export const useNotebookSession = () => useContext(Context);

class DocumentBoundary extends Component<{session: NotebookSession; children: ReactNode}, {error: string | null}> {
  state = {error: null as string | null};
  static getDerivedStateFromError(error: unknown) { return {error: String(error)}; }
  componentDidCatch(error: unknown) {
    post({type: 'error', requestId: this.props.session.requestId, noteId: this.props.session.noteId, message: String(error)});
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
      } else if (message.type === 'freeze' && typeof message.frozen === 'boolean') {
        frozen.current = message.frozen;
        document.documentElement.dataset.frozen = String(message.frozen);
        current.current?.setFrozen(message.frozen);
      } else if (message.type === 'navigate') {
        const active = current.current;
        if (!active || message.noteId !== active.noteId) return;
        if (typeof message.heading === 'string') active.navigate({heading: message.heading});
        else if (['top', 'table', 'code', 'mermaid', 'image'].includes(message.block)) active.navigate({block: message.block});
      } else if (message.type === 'load') {
        try {
          const doc = message.document;
          if (typeof message.noteId !== 'string' || !doc || doc.version !== 1 ||
              (doc.editorState !== null && typeof doc.editorState !== 'string') || !Array.isArray(doc.comments)) throw new Error('笔记文档格式无效');
          if (doc.editorState !== null) {
            const parsed = JSON.parse(doc.editorState);
            if (parsed?.root?.type !== 'root' || !Array.isArray(parsed.root.children)) throw new Error('笔记正文格式无效');
          }
          // Do not allow even a direct load to discard uncommitted source edits.
          if (current.current?.editor) current.current.snapshot();
          const next = new NotebookSession(message.noteId, doc, requestId);
          next.setFrozen(frozen.current);
          current.current = next;
          setSession(next);
        } catch (error) {
          post({type: 'error', requestId, noteId: message.noteId, message: String(error)});
        }
      } else if (message.type === 'flush') {
        try {
          if (!current.current) throw new Error('尚未载入笔记');
          post({type: 'result', requestId, noteId: current.current.noteId, document: current.current.snapshot(), ok: true});
        } catch (error) {
          // The host rejects this request, leaving the current note mounted.
          post({type: 'error', requestId, noteId: current.current?.noteId, message: String(error)});
        }
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const root = current.current?.editor?.getRootElement();
      if (root?.dataset.sourcePending === 'true' || (root?.dataset.sourceMode && root.dataset.sourceMode !== 'wysiwyg')) {
        event.preventDefault();
        event.returnValue = '';
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
    window.addEventListener('beforeunload', beforeUnload);
    post({type: 'ready'});
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('beforeunload', beforeUnload);
      for (const type of inputEvents) window.removeEventListener(type, stopFrozenInput, true);
    };
  }, []);
  return session
    ? <Context.Provider key={session.mountKey} value={session}><DocumentBoundary session={session}>{children}</DocumentBoundary></Context.Provider>
    : <div className="notebook-loading" role="status">正在载入笔记…</div>;
}

/** Safely hydrate only the CommentStore's documented JSON shape. */
export function hydrateComments(input: unknown[]): Comments {
  const comment = (value: unknown): value is Comments[number] & {type: 'comment'} => {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    return c.type === 'comment' && typeof c.id === 'string' && typeof c.author === 'string' &&
      typeof c.content === 'string' && typeof c.deleted === 'boolean' && typeof c.timeStamp === 'number';
  };
  return structuredClone(input.filter((value): value is Comments[number] => {
    if (comment(value)) return true;
    if (!value || typeof value !== 'object') return false;
    const thread = value as Record<string, unknown>;
    return thread.type === 'thread' && typeof thread.id === 'string' && typeof thread.quote === 'string' &&
      Array.isArray(thread.comments) && thread.comments.every(comment);
  }));
}

export function NotebookCommentBinding({store}: {store: CommentStore}) {
  const session = useNotebookSession();
  useEffect(() => {
    if (!session) return;
    session.commentStore = store;
    const stop = store.registerOnChange(session.dirty);
    return () => { stop(); if (session.commentStore === store) session.commentStore = null; };
  }, [session, store]);
  return null;
}

export function NotebookEditorBinding() {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  useEffect(() => session?.attach(editor), [editor, session]);
  return session ? <NotebookOutline session={session} /> : null;
}
