import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
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
  sendConversationMessage,
} from '../api.js';
import { ConversationView } from '../components/ConversationView.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebConversationSummary,
  ConfigWebConversationWorkspace,
  ConfigWebSessionDetails,
} from '../../../src/shared/types.js';

export function ConversationPage() {
  const [workspace, setWorkspace] = useState<ConfigWebConversationWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [session, setSession] = useState<ConfigWebSessionDetails | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const selectedIdRef = useRef('');
  const menuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const RefreshIcon = appIcons.refresh;
  const PlusIcon = appIcons.add;
  const FolderPlusIcon = appIcons.folderPlus;
  const SearchIcon = appIcons.search;
  const SendIcon = appIcons.send;
  const MoreIcon = appIcons.more;
  const ChevronDownIcon = appIcons.chevronDown;
  const ChevronRightIcon = appIcons.chevronRight;
  const FolderIcon = appIcons.folder;
  const ConversationIcon = appIcons.conversation;
  const TrashIcon = appIcons.trash;

  const selectedSummary = workspace?.conversations.find((item) => item.id === selectedId) ?? null;

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

  useEffect(() => {
    void reload();
  }, []);

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

  async function reload(preferredId = selectedIdRef.current) {
    setLoading(true);
    setError(null);
    try {
      const next = await readConversationWorkspace();
      const nextId = next.conversations.some((item) => item.id === preferredId)
        ? preferredId
        : (next.conversations[0]?.id ?? '');
      setWorkspace(next);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      if (nextId) await loadSession(nextId);
      else setSession(null);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadSession(id: string) {
    const sequence = ++requestSequence.current;
    if (!id) {
      setSession(null);
      return;
    }
    setSessionLoading(true);
    setError(null);
    try {
      const next = await readSessionDetails(id);
      if (requestSequence.current === sequence) setSession(next);
    } catch (loadError) {
      if (requestSequence.current === sequence) {
        setSession(null);
        setError(formatError(loadError));
      }
    } finally {
      if (requestSequence.current === sequence) setSessionLoading(false);
    }
  }

  function selectConversation(id: string) {
    selectedIdRef.current = id;
    setSelectedId(id);
    setMenuOpen(false);
    setNotice(null);
    void loadSession(id);
  }

  async function handleCreateConversation(folderId: string | null = null) {
    setError(null);
    setNotice(null);
    try {
      const created = await createConversation({ folderId });
      await reload(created.id);
      setNotice('已新建对话');
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
      const next = await createConversationFolder(name.trim() || undefined);
      setWorkspace(next);
      setNotice('已新建文件夹');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleToggleFolder(folderId: string, collapsed: boolean) {
    if (!workspace) return;
    try {
      const next = await patchConversationFolder({ id: folderId, collapsed: !collapsed });
      setWorkspace(next);
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleRenameFolder(folderId: string, currentName: string) {
    const nextName = window.prompt('重命名文件夹', currentName);
    if (nextName === null) return;
    try {
      const next = await patchConversationFolder({ id: folderId, name: nextName });
      setWorkspace(next);
      setNotice('文件夹已重命名');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleDeleteFolder(folderId: string, name: string) {
    if (!window.confirm(`删除文件夹「${name}」？其中的对话会回到未分组。`)) return;
    try {
      const next = await deleteConversationFolder(folderId);
      setWorkspace(next);
      setNotice('文件夹已删除');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleRenameConversation(id: string, currentTitle: string) {
    const nextTitle = window.prompt('重命名对话', currentTitle);
    if (nextTitle === null) return;
    try {
      const updated = await patchConversation({ id, title: nextTitle });
      setSession(updated);
      await reload(id);
      setNotice('对话已重命名');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleMoveConversation(id: string, currentFolderId: string | null) {
    if (!workspace) return;
    const options = ['未分组', ...workspace.folders.map((folder) => folder.name)];
    const answer = window.prompt(`移动到文件夹：\n${options.join('\n')}`, currentFolderId
      ? (workspace.folders.find((folder) => folder.id === currentFolderId)?.name ?? '未分组')
      : '未分组');
    if (answer === null) return;
    let folderId: string | null = null;
    if (answer.trim() && answer.trim() !== '未分组') {
      const matched = workspace.folders.find((folder) => folder.name === answer.trim());
      if (!matched) {
        setError(`未找到文件夹：${answer}`);
        return;
      }
      folderId = matched.id;
    }
    try {
      await patchConversation({ id, folderId });
      await reload(id);
      setNotice('对话已移动');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleDeleteConversation(id: string, title: string) {
    if (!window.confirm(`删除对话「${title}」？此操作不可恢复。`)) return;
    try {
      const next = await deleteConversation(id);
      setWorkspace(next);
      const nextId = next.conversations[0]?.id ?? '';
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      if (nextId) await loadSession(nextId);
      else setSession(null);
      setNotice('对话已删除');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleClearConversation(id: string) {
    if (!window.confirm('清空当前对话上下文？')) return;
    try {
      const updated = await clearConversation(id);
      setSession(updated);
      await reload(id);
      setNotice('上下文已清空');
    } catch (actionError) {
      setError(formatError(actionError));
    }
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || !selectedId || sending) return;
    setSending(true);
    setError(null);
    setNotice(null);
    setDraft('');
    try {
      const updated = await sendConversationMessage(selectedId, content);
      setSession(updated);
      await reload(selectedId);
      setNotice('消息已发送');
    } catch (actionError) {
      setError(formatError(actionError));
      setDraft(content);
    } finally {
      setSending(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  const folderSections = (workspace?.folders ?? []).map((folder) => ({
    folder,
    items: filtered
      .filter((item) => item.folderId === folder.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
  const ungrouped = filtered
    .filter((item) => item.folderId === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <PageFrame
      title="Conversation"
      path={workspace?.root}
      actions={
        <>
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void reload()} loading={loading} />
          <Button icon={<FolderPlusIcon size={15} />} title="新建文件夹" onClick={() => void handleCreateFolder()}>
            文件夹
          </Button>
          <Button icon={<PlusIcon size={15} />} title="新建对话" onClick={() => void handleCreateConversation(null)}>
            新建对话
          </Button>
        </>
      }
    >
      {error ? <Alert message={error} /> : null}
      {notice ? <div className="chat-notice">{notice}</div> : null}

      {!workspace ? (
        <Empty description={loading ? '正在加载对话…' : '暂无数据'} />
      ) : (
        <div className="chat-workspace">
          <aside className="chat-sidebar simple-card">
            <div className="chat-sidebar-actions">
              <Button icon={<PlusIcon size={15} />} onClick={() => void handleCreateConversation(null)}>
                新建对话
              </Button>
              <Button icon={<FolderPlusIcon size={15} />} title="新建文件夹" onClick={() => void handleCreateFolder()} />
            </div>

            <div className="chat-search">
              <SearchIcon size={14} aria-hidden="true" />
              <input
                value={query}
                type="search"
                placeholder="搜索对话"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            <div className="chat-tree">
              {folderSections.map(({ folder, items }) => (
                <section key={folder.id} className="chat-folder">
                  <div className="chat-folder-row">
                    <button
                      className="chat-folder-toggle"
                      type="button"
                      onClick={() => void handleToggleFolder(folder.id, folder.collapsed)}
                    >
                      {folder.collapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                      <FolderIcon size={14} />
                      <span>{folder.name}</span>
                      <em>{items.length}</em>
                    </button>
                    <div className="chat-row-actions">
                      <button type="button" title="在此新建对话" onClick={() => void handleCreateConversation(folder.id)}>
                        <PlusIcon size={13} />
                      </button>
                      <button type="button" title="重命名" onClick={() => void handleRenameFolder(folder.id, folder.name)}>
                        Aa
                      </button>
                      <button type="button" title="删除文件夹" onClick={() => void handleDeleteFolder(folder.id, folder.name)}>
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </div>
                  {!folder.collapsed
                    ? items.map((item) => (
                        <ConversationRow
                          key={item.id}
                          item={item}
                          active={item.id === selectedId}
                          icon={<ConversationIcon size={14} />}
                          onSelect={() => selectConversation(item.id)}
                        />
                      ))
                    : null}
                </section>
              ))}

              <section className="chat-folder">
                <div className="chat-folder-row chat-folder-row-static">
                  <div className="chat-folder-toggle static">
                    <span>未分组</span>
                    <em>{ungrouped.length}</em>
                  </div>
                </div>
                {ungrouped.map((item) => (
                  <ConversationRow
                    key={item.id}
                    item={item}
                    active={item.id === selectedId}
                    icon={<ConversationIcon size={14} />}
                    onSelect={() => selectConversation(item.id)}
                  />
                ))}
                {ungrouped.length === 0 && folderSections.every((section) => section.items.length === 0) ? (
                  <div className="chat-empty-hint">没有匹配的对话</div>
                ) : null}
              </section>
            </div>
          </aside>

          <section className="chat-main simple-card">
            {selectedSummary && session ? (
              <>
                <header className="chat-header">
                  <div className="chat-header-copy">
                    <div className="chat-header-title">
                      <ConversationIcon size={16} />
                      <h2 title={session.title}>{session.title}</h2>
                    </div>
                    <div className="chat-header-meta">
                      <Tag>{session.providerId}</Tag>
                      <Tag tone="blue">{session.model}</Tag>
                      <Tag>{selectedSummary.effort}</Tag>
                      <Tag tone="green">{session.role}</Tag>
                      <Tag>{session.turnState}</Tag>
                    </div>
                  </div>
                  <div className="chat-header-actions chat-menu" ref={menuRef}>
                    <button className="chat-conv-more" type="button" title="更多" onClick={() => setMenuOpen((open) => !open)}>
                      <MoreIcon size={16} />
                    </button>
                    {menuOpen ? (
                      <div className="chat-menu-panel">
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            void handleRenameConversation(session.id, session.title);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            void handleMoveConversation(session.id, selectedSummary.folderId);
                          }}
                        >
                          移动到文件夹…
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            void handleClearConversation(session.id);
                          }}
                        >
                          清空上下文
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => {
                            setMenuOpen(false);
                            void handleDeleteConversation(session.id, session.title);
                          }}
                        >
                          删除对话
                        </button>
                      </div>
                    ) : null}
                  </div>
                </header>

                <div className="chat-messages">
                  {sessionLoading ? <div className="session-loading">正在加载对话…</div> : null}
                  {session.conversation.items.length === 0 ? (
                    <Empty description="还没有消息，开始聊吧" />
                  ) : (
                    <ConversationView details={session.conversation} />
                  )}
                </div>

                <div className="chat-composer">
                  <textarea
                    ref={composerRef}
                    value={draft}
                    rows={3}
                    placeholder={sending ? '模型回复中…' : '输入消息，Enter 发送，Shift+Enter 换行'}
                    disabled={sending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onComposerKeyDown}
                  />
                  <div className="chat-composer-actions">
                    <span>{draft.trim().length} chars · Enter 发送</span>
                    <Button
                      icon={<SendIcon size={15} />}
                      disabled={!draft.trim() || sending}
                      loading={sending}
                      onClick={() => void handleSend()}
                    >
                      发送
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="chat-empty-main">
                <Empty description={workspace.conversations.length === 0 ? '还没有对话，先新建一个' : '选择左侧对话开始浏览'} />
                <Button icon={<PlusIcon size={15} />} onClick={() => void handleCreateConversation(null)}>
                  新建对话
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
    </PageFrame>
  );
}

function ConversationRow({
  item,
  active,
  icon,
  onSelect,
}: {
  item: ConfigWebConversationSummary;
  active: boolean;
  icon: ReactNode;
  onSelect(): void;
}) {
  return (
    <div className={`chat-conv-row${active ? ' active' : ''}`}>
      <button className="chat-conv-main" type="button" onClick={onSelect}>
        <span className="chat-conv-icon">{icon}</span>
        <span className="chat-conv-copy">
          <strong title={item.title}>{item.title}</strong>
          <span>
            {item.model} · {formatRelative(item.updatedAt)}
          </span>
        </span>
      </button>
    </div>
  );
}

function formatRelative(value: string): string {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return date.toLocaleDateString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
