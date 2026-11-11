import Input from '@arco-design/web-react/es/Input';
import {$isMarkNode, MarkNode} from '@lexical/mark';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, COMMAND_PRIORITY_LOW, SKIP_DOM_SELECTION_TAG} from 'lexical';
import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';

import {Button, Segmented} from '../../../../mica-config-ui/web/components/Ui';
import {useNotebookSession} from './NotebookBridge';
import {NOTEBOOK_ACTION_COMMAND} from './notebookActions';
import {
  $addNotebookCommentAnchor, $captureNotebookCommentAnchor, $getNotebookCommentIDs, $getNotebookCommentMarks,
  $isNotebookCommentAnchorValid, $isNotebookCommentAnchorSupported, createNotebookThread, formatNotebookCommentTime,
  isNotebookComment, isNotebookThread, notebookCommentDateTime, type NotebookCommentAnchor, type NotebookThread,
  registerNotebookCommentOverlap, replyToNotebookThread, resolveNotebookThread,
} from './notebookComments';
import './notebook-comments.css';

const EMPTY_COMMENTS: readonly unknown[] = [];

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>;
}

function CommentComposer({label, placeholder, disabled, value, onChange, onSubmit, onCancel, autoFocus = false}: {
  label: string; placeholder: string; disabled: boolean; value: string;
  onChange(value: string): void; onSubmit(content: string): boolean; onCancel?: () => void; autoFocus?: boolean;
}) {
  const composing = useRef(false);
  const submit = () => {
    if (disabled || composing.current || !value.trim()) return;
    if (onSubmit(value)) onChange('');
  };
  return <div className="notebook-comments-composer">
    <Input.TextArea
      className="notebook-comments-input"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      autoSize={{minRows: 2, maxRows: 6}}
      onChange={onChange}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
      }}
    />
    <div className="notebook-comments-composer-actions">
      {onCancel && <Button variant="ghost" size="compact" onClick={onCancel}>取消</Button>}
      <Button variant={value.trim() ? 'accent' : 'ghost'} size="compact" title={`${label}（⌘ / Ctrl + Enter）`} disabled={disabled || !value.trim()} onClick={submit}>发送</Button>
    </div>
  </div>;
}

export default function NotebookCommentsPanel() {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [editable, setEditable] = useState(editor.isEditable());
  const [filter, setFilter] = useState('pending');
  const [anchor, setAnchor] = useState<NotebookCommentAnchor | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const highlights = useRef(new Map<string, HTMLElement>());
  const subscribe = useCallback((listener: () => void) => session?.subscribeComments(listener) ?? (() => {}), [session]);
  const getSnapshot = useCallback(() => session?.getCommentSnapshot() ?? EMPTY_COMMENTS, [session]);
  const rows = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const threads = rows.filter(isNotebookThread);
  const pending = threads.filter((thread) => thread.resolved !== true);
  const resolved = threads.filter((thread) => thread.resolved === true);
  const visible = filter === 'resolved' ? resolved : pending;

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setActiveId(null);
    setMessage('');
  }, []);

  const captureSelection = useCallback(() => {
    const next = editor.read('pending', () => $captureNotebookCommentAnchor($getSelection()));
    setAnchor(next);
    setMessage('');
    return next;
  }, [editor]);

  const toggle = useCallback(() => {
    if (openRef.current) { close(); return; }
    if (!draft.trim()) captureSelection();
    setFilter('pending');
    openRef.current = true;
    setOpen(true);
  }, [captureSelection, close, draft]);

  useEffect(() => {
    setEditable(editor.isEditable());
    return editor.registerEditableListener(setEditable);
  }, [editor]);
  useEffect(() => registerNotebookCommentOverlap(editor), [editor]);
  useEffect(() => editor.registerCommand(NOTEBOOK_ACTION_COMMAND, (action) => {
    if (action !== 'comments') { close(); return false; }
    if (!editor.isComposing()) toggle();
    // These document actions also notify the other panels to close. Let all
    // listeners see the action regardless of their registration order.
    return false;
  }, COMMAND_PRIORITY_LOW), [close, editor, toggle]);

  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (!session || event.defaultPrevented || event.button !== 0 || editor.isComposing()) return;
      const target = event.target;
      const root = editor.getRootElement();
      if (!(target instanceof Node) || !root?.contains(target)) return;
      const element = target instanceof Element ? target : target.parentElement;
      const interactive = element?.closest('a, button, input, textarea, [contenteditable="false"]');
      if (interactive && interactive !== root) return;
      if (root.ownerDocument.getSelection()?.isCollapsed === false) return;
      const ids = editor.read(() => $getNotebookCommentIDs($getNearestNodeFromDOMNode(target)));
      const current = session.getCommentSnapshot().filter(isNotebookThread);
      const matches = ids.map((id) => current.find((thread) => thread.id === id)).filter(isNotebookThread);
      const thread = matches.find((match) => match.id === activeId) ??
        matches.find((match) => match.resolved !== true) ?? matches[0];
      if (!thread) return;
      if (!openRef.current) editor.dispatchCommand(NOTEBOOK_ACTION_COMMAND, 'comments');
      setAnchor(null);
      setFilter(thread.resolved === true ? 'resolved' : 'pending');
      setActiveId(thread.id);
      setMessage('');
    };
    const unregister = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('click', click);
      root?.addEventListener('click', click);
    });
    return () => { unregister(); editor.getRootElement()?.removeEventListener('click', click); };
  }, [activeId, editor, session]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || editor.isComposing()) return;
      if (event.code === 'KeyM' && event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        // Respect unrelated input fields: this shortcut belongs to this document.
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]') &&
          !editor.getRootElement()?.contains(target) && !target.closest('.notebook-comments')) return;
        event.preventDefault();
        editor.dispatchCommand(NOTEBOOK_ACTION_COMMAND, 'comments');
      } else if (event.key === 'Escape' && openRef.current) {
        event.preventDefault();
        close();
        editor.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [close, editor]);

  useEffect(() => {
    if (!open) return;
    document.body.dataset.notebookComments = 'open';
    return () => { delete document.body.dataset.notebookComments; };
  }, [open]);

  useEffect(() => {
    const clear = () => {
      for (const element of highlights.current.values()) element.classList.remove('notebook-comments-anchor-active');
      highlights.current.clear();
    };
    const paint = (mark: MarkNode) => {
      const element = editor.getElementByKey(mark.getKey());
      if (element) {
        element.classList.add('notebook-comments-anchor-active');
        highlights.current.set(mark.getKey(), element);
      }
    };
    if (!open || !activeId) return clear;
    editor.getEditorState().read(() => $getNotebookCommentMarks(activeId).forEach(paint));
    // Typing and caret movement must not walk the entire document. Only marks
    // that Lexical created, changed or destroyed need their highlight updated.
    const unregister = editor.registerMutationListener(MarkNode, mutations => {
      editor.getEditorState().read(() => {
        for (const [key, mutation] of mutations) {
          highlights.current.get(key)?.classList.remove('notebook-comments-anchor-active');
          highlights.current.delete(key);
          if (mutation === 'destroyed') continue;
          const mark = $getNodeByKey(key);
          if ($isMarkNode(mark) && mark.hasID(activeId)) paint(mark);
        }
      });
    }, {skipInitialization: true});
    return () => { unregister(); clear(); };
  }, [activeId, editor, open]);

  useEffect(() => {
    if (!open || !activeId) return;
    const article = [...(list.current?.querySelectorAll<HTMLElement>('[data-comment-thread]') ?? [])]
      .find((element) => element.dataset.commentThread === activeId);
    article?.scrollIntoView({block: 'nearest', behavior: 'auto'});
  }, [activeId, filter, open, rows]);

  const jumpToThread = (thread: NotebookThread) => {
    setActiveId(thread.id);
    const element = editor.getEditorState().read(() => {
      const mark = $getNotebookCommentMarks(thread.id)[0];
      return mark ? editor.getElementByKey(mark.getKey()) : null;
    });
    if (element) { element.scrollIntoView({block: 'center', behavior: 'auto'}); setMessage(''); }
    else setMessage('引用位置已被删除或撤销，评论记录仍然保留。');
  };

  const submitThread = (content: string): boolean => {
    if (!session || !editor.isEditable() || editor.isComposing() || !content.trim()) return false;
    const id = crypto.randomUUID();
    const thread = createNotebookThread(id, crypto.randomUUID(), content, anchor?.quote);
    let saved = false;
    if (anchor) {
      editor.update(() => {
        if (!$isNotebookCommentAnchorValid(anchor)) {
          setMessage('原选区已发生变化。请重新选择正文并点击「引用选区」，或改为全文评论。');
          return;
        }
        if (!$isNotebookCommentAnchorSupported(anchor)) {
          setMessage('代码块暂不支持选区评论。请点击「改为全文评论」后发送，已输入的内容会保留。');
          return;
        }
        saved = $addNotebookCommentAnchor(anchor, id, () => session.setComments([...session.getComments(), thread]));
        if (!saved) setMessage('评论未能保存。请确认文档仍可编辑后重试。');
      }, {discrete: true, tag: ['notebook-comment', SKIP_DOM_SELECTION_TAG]});
    } else saved = session.setComments([...session.getComments(), thread]);
    if (!saved) return false;
    setAnchor(null);
    setActiveId(id);
    setFilter('pending');
    setMessage('');
    return true;
  };

  const reply = (thread: NotebookThread, content: string): boolean => {
    if (!session || !editor.isEditable() || editor.isComposing() || !content.trim()) return false;
    // Read the current rows at commit time so another reply cannot be overwritten.
    const latest = session.getComments();
    const current = latest.find((row) => isNotebookThread(row) && row.id === thread.id);
    if (!isNotebookThread(current) || current.resolved === true) return false;
    const saved = session.setComments(replyToNotebookThread(latest, thread.id, crypto.randomUUID(), content));
    if (saved) setReplyToId(null);
    return saved;
  };

  const resolve = (thread: NotebookThread) => {
    if (!session || !editor.isEditable() || editor.isComposing()) return;
    const latest = session.getComments();
    const current = latest.find((row) => isNotebookThread(row) && row.id === thread.id);
    if (!isNotebookThread(current)) return;
    if (session.setComments(resolveNotebookThread(latest, current.id, current.resolved !== true))) {
      setActiveId(null);
      if (replyToId === current.id) setReplyToId(null);
      setMessage('');
    }
  };

  if (!session || !open) return null;
  return <aside className="notebook-document-panel notebook-comments" aria-label="文档评论">
    <header className="notebook-panel-header notebook-comments-header">
      <strong>评论</strong>
      <Button variant="ghost" size="compact" title="关闭评论（Esc）" icon={<CloseIcon />} onClick={close} />
    </header>
    <div className="notebook-comments-filter">
      <Segmented size="compact" value={filter} ariaLabel="评论状态" options={[
        {value: 'pending', label: `待处理 ${pending.length}`}, {value: 'resolved', label: `已解决 ${resolved.length}`},
      ]} onChange={(next) => { setFilter(next); setActiveId(null); setMessage(''); }} />
    </div>
    <div className="notebook-comments-list" ref={list}>
      {visible.length === 0 && <div className="notebook-comments-empty">
        <strong>{filter === 'resolved' ? '暂无已解决的评论' : '暂无待处理的评论'}</strong>
        <p>{filter === 'resolved' ? '已解决的评论会保留在这里，随时可以重新打开。' : editable ? '选中正文添加评论，或在下方发表全文评论。' : '这篇文档还没有待处理的评论。'}</p>
      </div>}
      {visible.map((thread, index) => <article key={`${thread.id}:${index}`} data-comment-thread={thread.id} className={`notebook-comments-thread${activeId === thread.id ? ' is-active' : ''}`}>
        {thread.quote && <Button className="notebook-comments-quote mica-arco-row" variant="ghost" size="compact" fullWidth title={`定位正文：${thread.quote}`} icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 4h4v5H3V4Zm0 5c0 2 1 3 3 3m3-8h4v5H9V4Zm0 5c0 2 1 3 3 3" /></svg>
        } onClick={() => jumpToThread(thread)}>{thread.quote}</Button>}
        {thread.comments.filter(isNotebookComment).map((comment, commentIndex) => <div className="notebook-comments-comment" key={`${comment.id}:${commentIndex}`}>
          <span className="notebook-comments-avatar" aria-hidden="true">{(comment.author || '我').slice(0, 1)}</span>
          <div className="notebook-comments-body">
            <div className="notebook-comments-byline"><strong>{comment.author || '我'}</strong><time dateTime={notebookCommentDateTime(comment.timeStamp)} title={formatNotebookCommentTime(comment.timeStamp, null)}>{formatNotebookCommentTime(comment.timeStamp)}</time></div>
            <p className={comment.deleted ? 'is-deleted' : undefined}>{comment.deleted ? '这条评论已删除' : comment.content}</p>
          </div>
        </div>)}
        {thread.comments.filter(isNotebookComment).length === 0 && <p className="notebook-comments-muted">此评论串的原始记录已保留，暂无可显示的内容。</p>}
        <div className="notebook-comments-thread-actions">
          {thread.resolved !== true && editable && <Button size="compact" variant="ghost" onClick={() => {
            setReplyToId(previous => previous === thread.id ? null : thread.id);
            setActiveId(thread.id);
          }}>回复</Button>}
          <Button size="compact" variant="ghost" disabled={!editable} onClick={() => resolve(thread)}>{thread.resolved === true ? '重新打开' : '解决'}</Button>
        </div>
        {thread.resolved !== true && editable && replyToId === thread.id && <CommentComposer label="回复评论" placeholder="回复评论…" disabled={!editable}
          value={replyDrafts[thread.id] ?? ''} onChange={value => setReplyDrafts(previous => ({...previous, [thread.id]: value}))}
          onCancel={() => setReplyToId(null)} autoFocus onSubmit={(content) => reply(thread, content)} />}
      </article>)}
    </div>
    {message && <div className="notebook-comments-message" role="status">{message}</div>}
    {editable ? <div className="notebook-comments-new">
      <div className="notebook-comments-new-heading">
        <strong>发表评论</strong>
        <Button size="compact" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (!captureSelection()) setMessage('请先在正文中选中需要评论的文字。');
        }}>引用选区</Button>
      </div>
      {anchor && <div className="notebook-comments-draft-quote"><p title={anchor.quote}>{anchor.quote}</p><Button size="compact" variant="ghost" onClick={() => { setAnchor(null); setMessage(''); }}>改为全文评论</Button></div>}
      <CommentComposer label="发表评论" placeholder={anchor ? '针对选中文字发表评论…' : '写下你的评论…'} disabled={!editable} value={draft} onChange={setDraft} onSubmit={submitThread} />
    </div> : <p className="notebook-comments-readonly">当前为只读模式，可以查看评论和定位引用。</p>}
  </aside>;
}
