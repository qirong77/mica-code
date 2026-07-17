import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Eraser,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  clearConversation,
  createConversation,
  createConversationFolder,
  deleteConversation,
  deleteConversationFolder,
  patchConversation,
  patchConversationFolder,
  readConversationWorkspace,
  readSessionDetails,
  streamConversationMessage,
} from '../api.js';
import {
  ChatTranscript,
  type TerminalLiveItem,
  type TerminalLiveTurn,
} from '../components/ChatTranscript.js';
import { PageFrame } from '../components/PageFrame.js';
import type {
  ConfigWebConversationStreamEvent,
  ConfigWebConversationSummary,
  ConfigWebConversationWorkspace,
  ConfigWebSessionDetails,
} from '../../../src/shared/types.js';

type StreamPhase = 'idle' | 'waiting_model' | 'thinking' | 'streaming' | 'calling_tool';

type LiveBuffer = {
  items: TerminalLiveItem[];
  thinkingChars: number;
};

export function ConversationPage() {
  const [workspace, setWorkspace] = useState<ConfigWebConversationWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [session, setSession] = useState<ConfigWebSessionDetails | null>(null);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingUser, setPendingUser] = useState('');
  const [liveTurn, setLiveTurn] = useState<TerminalLiveTurn | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>('idle');
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const requestSequence = useRef(0);
  const workspaceRequestSequence = useRef(0);
  const selectedIdRef = useRef('');
  const sendInFlightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamFailureCommittedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousSelectedIdRef = useRef('');
  const liveBufferRef = useRef<LiveBuffer>({ items: [], thinkingChars: 0 });
  const liveFrameRef = useRef<number | null>(null);
  const liveItemSequenceRef = useRef(0);
  const phaseRef = useRef<StreamPhase>('idle');
  const sendHandlerRef = useRef<(content: string) => Promise<boolean>>(() => Promise.resolve(false));
  const submitMessage = useCallback((content: string) => sendHandlerRef.current(content), []);

  const selectedSummary = workspace?.conversations.find((item) => item.id === selectedId) ?? null;
  const selectedFolder = workspace?.folders.find((folder) => folder.id === selectedSummary?.folderId) ?? null;

  const filtered = useMemo(() => {
    if (!workspace) return [] as ConfigWebConversationSummary[];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return workspace.conversations;
    return workspace.conversations.filter((item) => {
      const folderName = workspace.folders.find((folder) => folder.id === item.folderId)?.name ?? '';
      return `${item.title} ${item.model} ${item.providerId} ${folderName} ${item.id}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [query, workspace]);

  const folderSections = useMemo(
    () =>
      (workspace?.folders ?? []).map((folder) => ({
        folder,
        items: filtered
          .filter((item) => item.folderId === folder.id)
          .sort(compareConversations),
      })),
    [filtered, workspace?.folders],
  );
  const ungrouped = useMemo(
    () => filtered.filter((item) => item.folderId === null).sort(compareConversations),
    [filtered],
  );

  useEffect(() => {
    void reload();
    return () => {
      abortControllerRef.current?.abort();
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const switched = previousSelectedIdRef.current !== selectedId;
    previousSelectedIdRef.current = selectedId;
    if (switched || stickToBottomRef.current || pendingUser) {
      viewport.scrollTop = viewport.scrollHeight;
      stickToBottomRef.current = true;
      setAtBottom(true);
    }
  }, [selectedId, session?.conversation.updatedAt, pendingUser, liveTurn]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => observer.disconnect();
  }, [selectedId, session?.id]);

  async function reload(preferredId = selectedIdRef.current) {
    const workspaceSequence = ++workspaceRequestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readConversationWorkspace();
      if (workspaceRequestSequence.current !== workspaceSequence) return;
      const nextId = next.conversations.some((item) => item.id === preferredId)
        ? preferredId
        : (next.conversations[0]?.id ?? '');
      setWorkspace(next);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      if (nextId) await loadSession(nextId);
      else setSession(null);
    } catch (loadError) {
      if (workspaceRequestSequence.current === workspaceSequence) setError(formatError(loadError));
    } finally {
      if (workspaceRequestSequence.current === workspaceSequence) setLoading(false);
    }
  }

  async function loadSession(id: string) {
    const sequence = ++requestSequence.current;
    if (!id) {
      setSession(null);
      return;
    }
    setSessionLoading(true);
    setSession((current) => (current?.id === id ? current : null));
    setError(null);
    try {
      const next = await readSessionDetails(id);
      if (requestSequence.current === sequence && selectedIdRef.current === id) setSession(next);
    } catch (loadError) {
      if (requestSequence.current === sequence && selectedIdRef.current === id) {
        setSession(null);
        setError(formatError(loadError));
      }
    } finally {
      if (requestSequence.current === sequence && selectedIdRef.current === id) setSessionLoading(false);
    }
  }

  function selectConversation(id: string) {
    if (sending || id === selectedIdRef.current) {
      setDrawerOpen(false);
      return;
    }
    workspaceRequestSequence.current += 1;
    setLoading(false);
    selectedIdRef.current = id;
    setSelectedId(id);
    setSession(null);
    setDrawerOpen(false);
    setMenuOpen(false);
    setNotice(null);
    stickToBottomRef.current = true;
    void loadSession(id);
  }

  function applySessionResult(updated: ConfigWebSessionDetails, patch: Partial<ConfigWebConversationSummary> = {}) {
    if (selectedIdRef.current === updated.id) setSession(updated);
    setWorkspace((current) => {
      if (!current) return current;
      return {
        ...current,
        conversations: current.conversations.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                title: updated.title,
                updatedAt: updated.updatedAt,
                cwd: updated.cwd,
                turnState: updated.turnState,
                providerId: updated.providerId,
                model: updated.model,
                role: updated.role,
                ...patch,
              }
            : item,
        ),
      };
    });
  }

  async function handleCreateConversation(folderId: string | null = null) {
    if (sending) return;
    setError(null);
    try {
      const created = await createConversation({ folderId });
      const nextWorkspace = await readConversationWorkspace();
      workspaceRequestSequence.current += 1;
      requestSequence.current += 1;
      setLoading(false);
      setWorkspace(nextWorkspace);
      selectedIdRef.current = created.id;
      setSelectedId(created.id);
      setSession(created);
      setSessionLoading(false);
      setDrawerOpen(false);
      setNotice('new session created');
      stickToBottomRef.current = true;
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleCreateFolder() {
    const name = window.prompt('文件夹名称');
    if (name === null) return;
    setError(null);
    try {
      setWorkspace(await createConversationFolder({ name: name.trim() || undefined }));
      setNotice('folder created');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleToggleFolder(folderId: string, collapsed: boolean) {
    try {
      setWorkspace(await patchConversationFolder({ id: folderId, collapsed: !collapsed }));
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleRenameFolder(folderId: string, currentName: string) {
    const name = window.prompt('重命名文件夹', currentName);
    if (name === null || !name.trim()) return;
    try {
      setWorkspace(await patchConversationFolder({ id: folderId, name: name.trim() }));
      setNotice('folder renamed');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleDeleteFolder(folderId: string, name: string) {
    if (!window.confirm(`删除文件夹「${name}」？其中的对话会回到未分组。`)) return;
    try {
      setWorkspace(await deleteConversationFolder(folderId));
      setNotice('folder deleted');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleRenameConversation() {
    if (!session || sending) return;
    const title = window.prompt('重命名对话', session.title);
    if (title === null || !title.trim()) return;
    try {
      const updated = await patchConversation({ id: session.id, title: title.trim() });
      applySessionResult(updated);
      setNotice('session renamed');
      setMenuOpen(false);
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleMoveConversation() {
    if (!workspace || !session || sending) return;
    const options = ['未分组', ...workspace.folders.map((folder) => folder.name)];
    const answer = window.prompt(
      `移动到文件夹：\n${options.join('\n')}`,
      selectedFolder?.name ?? '未分组',
    );
    if (answer === null) return;
    const matched = workspace.folders.find((folder) => folder.name === answer.trim());
    if (answer.trim() && answer.trim() !== '未分组' && !matched) {
      setError(`未找到文件夹：${answer}`);
      return;
    }
    try {
      const folderId = matched?.id ?? null;
      const updated = await patchConversation({ id: session.id, folderId });
      applySessionResult(updated, { folderId });
      setNotice('session moved');
      setMenuOpen(false);
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleTogglePin() {
    if (!session || !selectedSummary || sending) return;
    try {
      const pinned = !selectedSummary.pinned;
      const updated = await patchConversation({ id: session.id, pinned });
      applySessionResult(updated, { pinned });
      setMenuOpen(false);
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleDeleteConversation() {
    if (!session || sending || !window.confirm(`删除对话「${session.title}」？此操作不可恢复。`)) return;
    try {
      const next = await deleteConversation(session.id);
      workspaceRequestSequence.current += 1;
      requestSequence.current += 1;
      setWorkspace(next);
      const nextId = next.conversations[0]?.id ?? '';
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      setMenuOpen(false);
      if (nextId) await loadSession(nextId);
      else setSession(null);
      setNotice('session deleted');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleClearConversation() {
    if (!session || sending || !window.confirm('清空当前对话上下文？')) return;
    try {
      const updated = await clearConversation(session.id);
      applySessionResult(updated);
      setMenuOpen(false);
      setNotice('context cleared');
      stickToBottomRef.current = true;
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  const flushLiveTurn = useCallback(() => {
    if (liveFrameRef.current !== null) return;
    liveFrameRef.current = requestAnimationFrame(() => {
      liveFrameRef.current = null;
      const current = liveBufferRef.current;
      setLiveTurn({
        thinkingChars: current.thinkingChars,
        items: current.items.map((item) => ({ ...item })),
      });
    });
  }, []);

  function updatePhase(next: StreamPhase) {
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    setStreamPhase(next);
  }

  function handleStreamEvent(event: ConfigWebConversationStreamEvent) {
    const buffer = liveBufferRef.current;
    if (event.type === 'error') {
      streamFailureCommittedRef.current = Boolean(event.inputCommitted);
      if (event.session && selectedIdRef.current === event.session.id) applySessionResult(event.session);
      return;
    }
    if (event.type === 'thinking_delta') {
      buffer.thinkingChars += event.content.length;
      updatePhase('thinking');
      flushLiveTurn();
      return;
    }
    if (event.type === 'text_delta') {
      const last = buffer.items.at(-1);
      if (last?.type === 'text') last.content += event.content;
      else buffer.items.push({ type: 'text', key: `live-text-${liveItemSequenceRef.current++}`, content: event.content });
      updatePhase('streaming');
      flushLiveTurn();
      return;
    }
    if (event.type === 'tool_call') {
      buffer.items.push({
        type: 'tool',
        key: `live-tool-${liveItemSequenceRef.current++}`,
        callId: event.callId,
        toolName: event.toolName,
        arguments: event.arguments,
        running: true,
      });
      updatePhase('calling_tool');
      flushLiveTurn();
      return;
    }
    if (event.type === 'tool_result') {
      const tool = [...buffer.items]
        .reverse()
        .find((item): item is Extract<TerminalLiveItem, { type: 'tool' }> =>
          item.type === 'tool' && item.running && (item.callId === event.callId || item.toolName === event.toolName),
        );
      if (tool) {
        tool.result = event.content;
        tool.running = false;
      }
      updatePhase('waiting_model');
      flushLiveTurn();
    }
  }

  async function handleSend(content: string): Promise<boolean> {
    const id = selectedIdRef.current;
    if (!content.trim() || !id || sendInFlightRef.current) return false;
    sendInFlightRef.current = true;
    stickToBottomRef.current = true;
    setAtBottom(true);
    setSending(true);
    setError(null);
    setNotice(null);
    setPendingUser(content.trim());
    liveBufferRef.current = { items: [], thinkingChars: 0 };
    liveItemSequenceRef.current = 0;
    setLiveTurn({ items: [], thinkingChars: 0 });
    phaseRef.current = 'waiting_model';
    setStreamPhase('waiting_model');
    setStreamStartedAt(Date.now());
    streamFailureCommittedRef.current = false;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const updated = await streamConversationMessage(id, content.trim(), handleStreamEvent, abortController.signal);
      if (selectedIdRef.current === id) applySessionResult(updated);
      return true;
    } catch (actionError) {
      if (!abortController.signal.aborted) setError(formatError(actionError));
      return streamFailureCommittedRef.current;
    } finally {
      if (liveFrameRef.current !== null) {
        cancelAnimationFrame(liveFrameRef.current);
        liveFrameRef.current = null;
      }
      sendInFlightRef.current = false;
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      setPendingUser('');
      setLiveTurn(null);
      setSending(false);
      phaseRef.current = 'idle';
      setStreamPhase('idle');
      setStreamStartedAt(null);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }

  sendHandlerRef.current = handleSend;

  function handleViewportScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextAtBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
    stickToBottomRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
  }

  function scrollToBottom() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    stickToBottomRef.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
  }

  const terminalContent = (() => {
    if (loading && !workspace) {
      return <div className="terminal-loading"><span /> loading sessions…</div>;
    }
    if (!selectedId || session?.id !== selectedId) {
      if (sessionLoading) return <div className="terminal-loading"><span /> loading session…</div>;
      return (
        <div className="terminal-welcome">
          <div className="terminal-welcome-logo">mica</div>
          <p>No conversation selected.</p>
          <button type="button" onClick={() => void handleCreateConversation(null)}>
            <Plus size={15} /> new session
          </button>
        </div>
      );
    }
    return (
      <ChatTranscript
        details={session.conversation}
        pendingUser={pendingUser || undefined}
        liveTurn={liveTurn}
      />
    );
  })();

  return (
    <PageFrame title="Conversation" immersive>
      <div className="terminal-page">
        <header className="terminal-header">
          <button
            className={`terminal-icon-button${drawerOpen ? ' active' : ''}`}
            type="button"
            title="Sessions"
            aria-label="打开会话列表"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <PanelLeft size={17} />
          </button>
          <div className="terminal-header-divider" />
          <div className="terminal-title-block">
            <div className="terminal-title-line">
              {selectedFolder ? <span>{selectedFolder.name} / </span> : null}
              <strong title={session?.title} onDoubleClick={() => void handleRenameConversation()}>
                {session?.title ?? 'Conversation'}
              </strong>
            </div>
            <div className="terminal-path" title={session?.cwd ?? workspace?.root}>
              {session?.cwd ?? workspace?.root ?? 'Mica workspace'}
            </div>
          </div>
          <div className="terminal-header-meta">
            {selectedSummary ? <span>{selectedSummary.providerId}</span> : null}
            {selectedSummary ? <span className="terminal-model-name">{selectedSummary.model}_{selectedSummary.effort}</span> : null}
          </div>
          <button
            className="terminal-icon-button"
            type="button"
            title="New session"
            aria-label="新建对话"
            disabled={sending}
            onClick={() => void handleCreateConversation(selectedSummary?.folderId ?? null)}
          >
            <Plus size={18} />
          </button>
          <div className="terminal-menu" ref={menuRef}>
            <button
              className={`terminal-icon-button${menuOpen ? ' active' : ''}`}
              type="button"
              title="Session actions"
              aria-label="会话操作"
              disabled={!session}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={18} />
            </button>
            {menuOpen && session ? (
              <div className="terminal-menu-panel">
                <button type="button" onClick={() => void handleTogglePin()}>
                  {selectedSummary?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  {selectedSummary?.pinned ? 'Unpin session' : 'Pin session'}
                </button>
                <button type="button" onClick={() => void handleRenameConversation()}>Rename session</button>
                <button type="button" onClick={() => void handleMoveConversation()}>Move to folder…</button>
                <button type="button" onClick={() => void handleClearConversation()}>
                  <Eraser size={14} /> Clear context
                </button>
                <button className="danger" type="button" onClick={() => void handleDeleteConversation()}>
                  <Trash2 size={14} /> Delete session
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {drawerOpen ? (
          <>
            <button className="terminal-drawer-backdrop" type="button" aria-label="关闭会话列表" onClick={() => setDrawerOpen(false)} />
            <aside className="terminal-session-drawer">
              <div className="terminal-drawer-header">
                <strong>Sessions</strong>
                <div>
                  <button type="button" title="Refresh" onClick={() => void reload()}><RefreshCw size={14} /></button>
                  <button type="button" title="New folder" onClick={() => void handleCreateFolder()}><FolderPlus size={14} /></button>
                  <button type="button" title="Close" onClick={() => setDrawerOpen(false)}><X size={15} /></button>
                </div>
              </div>
              <label className="terminal-session-search">
                <Search size={14} />
                <input value={query} type="search" placeholder="Search sessions…" onChange={(event) => setQuery(event.target.value)} />
              </label>
              <div className="terminal-session-tree">
                {folderSections.map(({ folder, items }) => (
                  <section className="terminal-folder" key={folder.id}>
                    <div className="terminal-folder-row">
                      <button type="button" onClick={() => void handleToggleFolder(folder.id, folder.collapsed)}>
                        {folder.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <Folder size={13} />
                        <span>{folder.name}</span>
                        <em>{items.length}</em>
                      </button>
                      <div>
                        <button type="button" title="New session here" onClick={() => void handleCreateConversation(folder.id)}><Plus size={12} /></button>
                        <button type="button" title="Rename folder" onClick={() => void handleRenameFolder(folder.id, folder.name)}>Aa</button>
                        <button type="button" title="Delete folder" onClick={() => void handleDeleteFolder(folder.id, folder.name)}><Trash2 size={12} /></button>
                      </div>
                    </div>
                    {!folder.collapsed
                      ? items.map((item) => (
                          <ConversationRow
                            key={item.id}
                            item={item}
                            active={item.id === selectedId}
                            disabled={sending}
                            onSelect={() => selectConversation(item.id)}
                          />
                        ))
                      : null}
                  </section>
                ))}
                <section className="terminal-folder">
                  <div className="terminal-folder-label"><span>Ungrouped</span><em>{ungrouped.length}</em></div>
                  {ungrouped.map((item) => (
                    <ConversationRow
                      key={item.id}
                      item={item}
                      active={item.id === selectedId}
                      disabled={sending}
                      onSelect={() => selectConversation(item.id)}
                    />
                  ))}
                </section>
                {filtered.length === 0 ? <div className="terminal-no-results">No matching sessions</div> : null}
              </div>
              <div className="terminal-drawer-footer" title={workspace?.root}>{workspace?.root}</div>
            </aside>
          </>
        ) : null}

        {error ? <div className="terminal-toast terminal-toast-error"><span>error</span>{error}<button type="button" onClick={() => setError(null)}><X size={13} /></button></div> : null}
        {notice ? <div className="terminal-toast"><span>mica</span>{notice}</div> : null}

        <div className="terminal-viewport-shell">
          <div className="terminal-viewport" ref={viewportRef} onScroll={handleViewportScroll}>
            {terminalContent}
          </div>
          {!atBottom ? (
            <button className="terminal-scroll-bottom" type="button" title="Scroll to bottom" onClick={scrollToBottom}>
              <ArrowDown size={15} />
            </button>
          ) : null}
          {sessionLoading && session ? <div className="terminal-session-loading">loading…</div> : null}
        </div>

        <TerminalComposer
          key={selectedId || 'no-session'}
          textareaRef={composerRef}
          disabled={session?.id !== selectedId || sessionLoading}
          sending={sending}
          onSend={submitMessage}
        />
        <TerminalStatus
          phase={streamPhase}
          startedAt={streamStartedAt}
          model={selectedSummary?.model ?? session?.model ?? ''}
          effort={selectedSummary?.effort ?? ''}
          thinkingChars={liveTurn?.thinkingChars ?? 0}
          updatedAt={session?.updatedAt}
        />
      </div>
    </PageFrame>
  );
}

const TerminalComposer = memo(function TerminalComposer({
  textareaRef,
  disabled,
  sending,
  onSend,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  sending: boolean;
  onSend(content: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const submittingRef = useRef(false);

  function resize(textarea: HTMLTextAreaElement) {
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(144, Math.max(28, textarea.scrollHeight))}px`;
  }

  async function submit() {
    const content = draft.trim();
    if (!content || disabled || sending || submittingRef.current) return;
    submittingRef.current = true;
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = '28px';
    const sent = await onSend(content);
    if (!sent) {
      setDraft((current) => (current.trim() ? `${content}\n\n${current}` : content));
      requestAnimationFrame(() => {
        if (textareaRef.current) resize(textareaRef.current);
      });
    }
    submittingRef.current = false;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!sending) void submit();
  }

  return (
    <div className={`terminal-composer${sending ? ' terminal-composer-busy' : ''}`}>
      <span className="terminal-prompt-marker" aria-hidden="true">❯</span>
      <textarea
        ref={textareaRef}
        value={draft}
        rows={1}
        aria-label="Message Mica"
        disabled={disabled}
        placeholder={sending ? 'Mica is working — you can prepare the next message…' : 'Type a message to start a conversation'}
        onChange={(event) => {
          setDraft(event.target.value);
          resize(event.target);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        aria-label="发送消息"
        title="Send · Enter"
        disabled={disabled || sending || !draft.trim()}
        onClick={() => void submit()}
      >
        {sending ? <span className="terminal-mini-spinner" /> : '↵'}
      </button>
    </div>
  );
});

function TerminalStatus({
  phase,
  startedAt,
  model,
  effort,
  thinkingChars,
  updatedAt,
}: {
  phase: StreamPhase;
  startedAt: number | null;
  model: string;
  effort: string;
  thinkingChars: number;
  updatedAt?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase === 'idle') return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [phase]);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const status = phase === 'idle' ? 'idle' : phase;

  return (
    <footer className="terminal-status">
      <div>
        {phase !== 'idle' ? <span className="terminal-status-spinner">⋮</span> : <span className="terminal-status-idle">#</span>}
        <span>{status}</span>
        {elapsed ? <span>{formatDuration(elapsed)}</span> : null}
        {thinkingChars > 0 && phase === 'thinking' ? <span>↓{estimateTokens(thinkingChars)} tokens</span> : null}
      </div>
      <div>
        <span>{model}{effort ? `_${effort}` : ''}</span>
        {updatedAt ? <time dateTime={updatedAt}>{formatClock(updatedAt)}</time> : null}
      </div>
    </footer>
  );
}

const ConversationRow = memo(function ConversationRow({
  item,
  active,
  disabled,
  onSelect,
}: {
  item: ConfigWebConversationSummary;
  active: boolean;
  disabled: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={`terminal-session-row${active ? ' active' : ''}`}
      type="button"
      disabled={disabled}
      onClick={onSelect}
    >
      <MessageSquare size={13} />
      <span>
        <strong title={item.title}>{item.title}</strong>
        <small>{item.model} · {formatRelativeTime(item.updatedAt)}</small>
      </span>
      {item.pinned ? <Pin size={11} className="terminal-row-pin" /> : null}
      <i className={`terminal-state-dot state-${item.turnState}`} title={item.turnState} />
    </button>
  );
});

function compareConversations(a: ConfigWebConversationSummary, b: ConfigWebConversationSummary): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function estimateTokens(characters: number): number {
  return Math.max(1, Math.ceil(characters / 3));
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
