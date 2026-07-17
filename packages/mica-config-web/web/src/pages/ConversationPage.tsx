import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';

type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
};

type Conversation = {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: string;
  provider: string;
  model: string;
  effort: string;
  role: string;
  messages: ChatMessage[];
};

type Folder = {
  id: string;
  name: string;
  collapsed: boolean;
};

type MockStore = {
  folders: Folder[];
  conversations: Conversation[];
};

const MOCK_ROOT = 'mock://conversations';

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createMockStore(): MockStore {
  return {
    folders: [
      { id: 'folder_work', name: '工作项目', collapsed: false },
      { id: 'folder_daily', name: '日常杂项', collapsed: false },
      { id: 'folder_archive', name: '归档', collapsed: true },
    ],
    conversations: [
      {
        id: 'conv_rewind',
        title: '修 rewind bug',
        folderId: 'folder_work',
        updatedAt: '2026-07-12T10:20:00.000Z',
        provider: 'openai',
        model: 'gpt-5.2',
        effort: 'medium',
        role: 'default',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '帮我看一下 rewind 回退后文件状态为什么不对？',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: '先核对 checkpoint 边界和 turn 结束后的更新时机。',
          },
          {
            id: 'm3',
            role: 'tool',
            toolName: 'read_file',
            content: 'packages/mica-runtime/.../RewindCheckpointManager.ts\n发现 turn 结束后没有写回最终文件状态。',
          },
          {
            id: 'm4',
            role: 'assistant',
            content: '问题在于 checkpoint 只在 turn 开始时创建，结束后没有更新为完成态。可以在 turn 成功后再写回对话和文件快照。',
          },
        ],
      },
      {
        id: 'conv_page',
        title: '加 Conversation 页面',
        folderId: 'folder_work',
        updatedAt: '2026-07-12T11:05:00.000Z',
        provider: 'openai',
        model: 'gpt-5.2',
        effort: 'low',
        role: 'default',
        messages: [
          {
            id: 'm5',
            role: 'user',
            content: '在 config-web 里加一个 ChatGPT 风格的 conversation 页面，数据先 mock。',
          },
          {
            id: 'm6',
            role: 'assistant',
            content: '可以。左侧做文件夹树和会话列表，右侧做消息流和输入框，先保证可点击交互。',
          },
        ],
      },
      {
        id: 'conv_mcp',
        title: '调试 MCP 连接',
        folderId: 'folder_work',
        updatedAt: '2026-07-11T18:40:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        effort: 'high',
        role: 'default',
        messages: [
          {
            id: 'm7',
            role: 'user',
            content: 'MCP reconnect 失败后工具列表会不会残留？',
          },
          {
            id: 'm8',
            role: 'assistant',
            content: '失败后也要刷新注册工具，避免 stale tools。',
          },
        ],
      },
      {
        id: 'conv_commit',
        title: '写 commit 文案',
        folderId: 'folder_daily',
        updatedAt: '2026-07-10T09:12:00.000Z',
        provider: 'openai',
        model: 'gpt-5.2',
        effort: 'none',
        role: 'default',
        messages: [
          {
            id: 'm9',
            role: 'user',
            content: '帮我写一条简洁的 commit message。',
          },
          {
            id: 'm10',
            role: 'assistant',
            content: 'feat(config-web): add mock conversation workspace',
          },
        ],
      },
      {
        id: 'conv_archived',
        title: '旧版 provider 切换',
        folderId: 'folder_archive',
        updatedAt: '2026-06-28T14:00:00.000Z',
        provider: 'openai',
        model: 'gpt-4.1',
        effort: 'low',
        role: 'default',
        messages: [
          {
            id: 'm11',
            role: 'user',
            content: '切换 provider 时 effort 要 clamp。',
          },
          {
            id: 'm12',
            role: 'assistant',
            content: '对，同时同步 context window size。',
          },
        ],
      },
      {
        id: 'conv_loose',
        title: '临时试一下 model',
        folderId: null,
        updatedAt: '2026-07-12T08:30:00.000Z',
        provider: 'openai',
        model: 'gpt-5.2',
        effort: 'none',
        role: 'default',
        messages: [
          {
            id: 'm13',
            role: 'user',
            content: '这个模型支持 xhigh 吗？',
          },
          {
            id: 'm14',
            role: 'assistant',
            content: '先看 Models.dev 的 effort 映射，没有就回退到默认 none/low/medium/high。',
          },
        ],
      },
    ],
  };
}

function formatRelativeTime(iso: string) {
  const delta = Date.now() - new Date(iso).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
  return new Date(iso).toLocaleDateString();
}

function mockAssistantReply(userText: string) {
  const trimmed = userText.trim();
  if (!trimmed) return '收到空消息。';
  if (trimmed.length < 24) return `（mock）已收到：${trimmed}`;
  return `（mock）已记录你的问题。\n\n摘要：${trimmed.slice(0, 80)}${trimmed.length > 80 ? '…' : ''}\n\n下一步可以继续补充上下文，或新建文件夹整理会话。`;
}

export function ConversationPage() {
  const [store, setStore] = useState<MockStore>(() => createMockStore());
  const [selectedId, setSelectedId] = useState('conv_page');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const AddIcon = appIcons.add;
  const FolderPlusIcon = appIcons.folderPlus;
  const SearchIcon = appIcons.search;
  const SendIcon = appIcons.send;
  const FolderIcon = appIcons.folder;
  const ConversationIcon = appIcons.conversation;
  const MoreIcon = appIcons.more;
  const ChevronRightIcon = appIcons.chevronRight;
  const ChevronDownIcon = appIcons.chevronDown;
  const TrashIcon = appIcons.trash;

  const selected = store.conversations.find((item) => item.id === selectedId) ?? null;

  const filteredConversations = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return store.conversations;
    return store.conversations.filter((item) => {
      const folderName = store.folders.find((folder) => folder.id === item.folderId)?.name ?? '';
      return `${item.title} ${item.model} ${folderName}`.toLocaleLowerCase().includes(normalized);
    });
  }, [query, store.conversations, store.folders]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [selected?.id, selected?.messages.length]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.chat-menu')) setMenuOpenId(null);
    }
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, []);

  function selectConversation(id: string) {
    setSelectedId(id);
    setMenuOpenId(null);
    setDraft('');
  }

  function createConversation(folderId: string | null = null) {
    const id = createId('conv');
    const conversation: Conversation = {
      id,
      title: '新对话',
      folderId,
      updatedAt: nowIso(),
      provider: 'openai',
      model: 'gpt-5.2',
      effort: 'medium',
      role: 'default',
      messages: [
        {
          id: createId('msg'),
          role: 'assistant',
          content: '这是一个 mock 对话。直接输入消息体验交互即可。',
        },
      ],
    };
    setStore((prev) => ({
      ...prev,
      conversations: [conversation, ...prev.conversations],
      folders: prev.folders.map((folder) =>
        folder.id === folderId ? { ...folder, collapsed: false } : folder,
      ),
    }));
    setSelectedId(id);
    setDraft('');
    setMenuOpenId(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function createFolder() {
    const name = window.prompt('文件夹名称', '新文件夹')?.trim();
    if (!name) return;
    const id = createId('folder');
    setStore((prev) => ({
      ...prev,
      folders: [{ id, name, collapsed: false }, ...prev.folders],
    }));
  }

  function toggleFolder(folderId: string) {
    setStore((prev) => ({
      ...prev,
      folders: prev.folders.map((folder) =>
        folder.id === folderId ? { ...folder, collapsed: !folder.collapsed } : folder,
      ),
    }));
  }

  function renameConversation(id: string) {
    const current = store.conversations.find((item) => item.id === id);
    if (!current) return;
    const next = window.prompt('重命名对话', current.title)?.trim();
    if (!next || next === current.title) {
      setMenuOpenId(null);
      return;
    }
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((item) =>
        item.id === id ? { ...item, title: next, updatedAt: nowIso() } : item,
      ),
    }));
    setMenuOpenId(null);
  }

  function renameFolder(folderId: string) {
    const current = store.folders.find((item) => item.id === folderId);
    if (!current) return;
    const next = window.prompt('重命名文件夹', current.name)?.trim();
    if (!next || next === current.name) return;
    setStore((prev) => ({
      ...prev,
      folders: prev.folders.map((item) => (item.id === folderId ? { ...item, name: next } : item)),
    }));
  }

  function moveConversation(id: string) {
    const current = store.conversations.find((item) => item.id === id);
    if (!current) return;
    const options = ['未分组', ...store.folders.map((folder) => folder.name)];
    const answer = window.prompt(`移动到（输入名称）\n${options.join('\n')}`, '未分组')?.trim();
    if (!answer) {
      setMenuOpenId(null);
      return;
    }
    let folderId: string | null = null;
    if (answer !== '未分组') {
      const matched = store.folders.find((folder) => folder.name === answer);
      if (!matched) {
        window.alert('未找到该文件夹');
        return;
      }
      folderId = matched.id;
    }
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((item) =>
        item.id === id ? { ...item, folderId, updatedAt: nowIso() } : item,
      ),
      folders: prev.folders.map((folder) =>
        folder.id === folderId ? { ...folder, collapsed: false } : folder,
      ),
    }));
    setMenuOpenId(null);
  }

  function deleteConversation(id: string) {
    const current = store.conversations.find((item) => item.id === id);
    if (!current) return;
    if (!window.confirm(`删除对话「${current.title}」？`)) {
      setMenuOpenId(null);
      return;
    }
    setStore((prev) => {
      const conversations = prev.conversations.filter((item) => item.id !== id);
      return { ...prev, conversations };
    });
    if (selectedId === id) {
      const next = store.conversations.find((item) => item.id !== id);
      setSelectedId(next?.id ?? '');
    }
    setMenuOpenId(null);
  }

  function deleteFolder(folderId: string) {
    const current = store.folders.find((item) => item.id === folderId);
    if (!current) return;
    if (!window.confirm(`删除文件夹「${current.name}」？其中的对话会移到未分组。`)) return;
    setStore((prev) => ({
      folders: prev.folders.filter((item) => item.id !== folderId),
      conversations: prev.conversations.map((item) =>
        item.folderId === folderId ? { ...item, folderId: null } : item,
      ),
    }));
  }

  function clearConversation(id: string) {
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((item) =>
        item.id === id
          ? {
              ...item,
              updatedAt: nowIso(),
              messages: [
                {
                  id: createId('msg'),
                  role: 'assistant',
                  content: '上下文已清空（mock）。可以继续提问。',
                },
              ],
            }
          : item,
      ),
    }));
    setMenuOpenId(null);
  }

  async function sendMessage() {
    if (!selected || sending) return;
    const text = draft.trim();
    if (!text) return;

    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: text,
    };

    setDraft('');
    setSending(true);
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations
        .map((item) =>
          item.id === selected.id
            ? {
                ...item,
                title: item.title === '新对话' ? text.slice(0, 24) || item.title : item.title,
                updatedAt: nowIso(),
                messages: [...item.messages, userMessage],
              }
            : item,
        )
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    }));

    await new Promise((resolve) => window.setTimeout(resolve, 450));

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: mockAssistantReply(text),
    };

    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations
        .map((item) =>
          item.id === selected.id
            ? {
                ...item,
                updatedAt: nowIso(),
                messages: [...item.messages, assistantMessage],
              }
            : item,
        )
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    }));
    setSending(false);
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const folderSections = store.folders.map((folder) => ({
    folder,
    items: filteredConversations
      .filter((item) => item.folderId === folder.id)
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
  }));

  const ungrouped = filteredConversations
    .filter((item) => item.folderId === null)
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));

  return (
    <PageFrame title="Conversation" path={MOCK_ROOT}>
      <div className="chat-workspace">
        <aside className="chat-sidebar simple-card">
          <div className="chat-sidebar-actions">
            <Button variant="primary" icon={<AddIcon size={14} />} onClick={() => createConversation(null)}>
              新建对话
            </Button>
            <Button icon={<FolderPlusIcon size={14} />} title="新建文件夹" onClick={createFolder} />
          </div>

          <label className="chat-search">
            <SearchIcon size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索对话…"
              aria-label="搜索对话"
            />
          </label>

          <div className="chat-tree">
            {folderSections.map(({ folder, items }) => (
              <section key={folder.id} className="chat-folder">
                <div className="chat-folder-row">
                  <button className="chat-folder-toggle" type="button" onClick={() => toggleFolder(folder.id)}>
                    {folder.collapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                    <FolderIcon size={14} />
                    <span>{folder.name}</span>
                    <em>{items.length}</em>
                  </button>
                  <div className="chat-row-actions">
                    <button type="button" title="在此新建对话" onClick={() => createConversation(folder.id)}>
                      <AddIcon size={13} />
                    </button>
                    <button type="button" title="重命名" onClick={() => renameFolder(folder.id)}>
                      Aa
                    </button>
                    <button type="button" title="删除文件夹" onClick={() => deleteFolder(folder.id)}>
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
                        menuOpen={menuOpenId === item.id}
                        icon={<ConversationIcon size={14} />}
                        moreIcon={<MoreIcon size={14} />}
                        onSelect={() => selectConversation(item.id)}
                        onToggleMenu={() => setMenuOpenId((prev) => (prev === item.id ? null : item.id))}
                        onRename={() => renameConversation(item.id)}
                        onMove={() => moveConversation(item.id)}
                        onClear={() => clearConversation(item.id)}
                        onDelete={() => deleteConversation(item.id)}
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
                  menuOpen={menuOpenId === item.id}
                  icon={<ConversationIcon size={14} />}
                  moreIcon={<MoreIcon size={14} />}
                  onSelect={() => selectConversation(item.id)}
                  onToggleMenu={() => setMenuOpenId((prev) => (prev === item.id ? null : item.id))}
                  onRename={() => renameConversation(item.id)}
                  onMove={() => moveConversation(item.id)}
                  onClear={() => clearConversation(item.id)}
                  onDelete={() => deleteConversation(item.id)}
                />
              ))}
            </section>

            {filteredConversations.length === 0 ? <div className="chat-empty-hint">没有匹配的对话</div> : null}
          </div>
        </aside>

        <section className="chat-main simple-card">
          {!selected ? (
            <div className="chat-empty-main">
              <Empty description="还没有选中对话" />
              <Button variant="primary" icon={<AddIcon size={14} />} onClick={() => createConversation(null)}>
                新建对话
              </Button>
            </div>
          ) : (
            <>
              <header className="chat-header">
                <div className="chat-header-copy">
                  <div className="chat-header-title">
                    <ConversationIcon size={16} />
                    <h2>{selected.title}</h2>
                  </div>
                  <div className="chat-header-meta">
                    <Tag>{selected.provider}</Tag>
                    <Tag tone="blue">{selected.model}</Tag>
                    <Tag>{selected.effort}</Tag>
                    <Tag>{selected.role}</Tag>
                    <span>{formatRelativeTime(selected.updatedAt)}</span>
                  </div>
                </div>
                <div className="chat-header-actions chat-menu">
                  <Button
                    icon={<MoreIcon size={14} />}
                    title="会话菜单"
                    pressed={menuOpenId === `header:${selected.id}`}
                    onClick={() =>
                      setMenuOpenId((prev) => (prev === `header:${selected.id}` ? null : `header:${selected.id}`))
                    }
                  />
                  {menuOpenId === `header:${selected.id}` ? (
                    <div className="chat-menu-panel">
                      <button type="button" onClick={() => renameConversation(selected.id)}>
                        重命名
                      </button>
                      <button type="button" onClick={() => moveConversation(selected.id)}>
                        移动到文件夹…
                      </button>
                      <button type="button" onClick={() => clearConversation(selected.id)}>
                        清空上下文
                      </button>
                      <button type="button" className="danger" onClick={() => deleteConversation(selected.id)}>
                        删除对话
                      </button>
                    </div>
                  ) : null}
                </div>
              </header>

              <div className="chat-messages">
                {selected.messages.map((message) => (
                  <article key={message.id} className={`chat-bubble chat-bubble-${message.role}`}>
                    <div className="chat-bubble-meta">
                      <strong>
                        {message.role === 'user'
                          ? 'You'
                          : message.role === 'assistant'
                            ? 'Assistant'
                            : message.role === 'tool'
                              ? `Tool · ${message.toolName ?? 'unknown'}`
                              : 'System'}
                      </strong>
                    </div>
                    <pre className="chat-bubble-content">{message.content}</pre>
                  </article>
                ))}
                {sending ? (
                  <article className="chat-bubble chat-bubble-assistant chat-bubble-pending">
                    <div className="chat-bubble-meta">
                      <strong>Assistant</strong>
                    </div>
                    <div className="chat-bubble-content">正在生成 mock 回复…</div>
                  </article>
                ) : null}
                <div ref={messagesEndRef} />
              </div>

              <footer className="chat-composer">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder="输入消息… Enter 发送，Shift+Enter 换行"
                  rows={3}
                />
                <div className="chat-composer-actions">
                  <span>mock 数据 · 不会请求真实模型</span>
                  <Button
                    variant="primary"
                    icon={<SendIcon size={14} />}
                    loading={sending}
                    onClick={() => void sendMessage()}
                  >
                    发送
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    </PageFrame>
  );
}

function ConversationRow({
  item,
  active,
  menuOpen,
  icon,
  moreIcon,
  onSelect,
  onToggleMenu,
  onRename,
  onMove,
  onClear,
  onDelete,
}: {
  item: Conversation;
  active: boolean;
  menuOpen: boolean;
  icon: ReactNode;
  moreIcon: ReactNode;
  onSelect(): void;
  onToggleMenu(): void;
  onRename(): void;
  onMove(): void;
  onClear(): void;
  onDelete(): void;
}) {
  return (
    <div className={`chat-conv-row ${active ? 'active' : ''}`}>
      <button className="chat-conv-main" type="button" onClick={onSelect}>
        <span className="chat-conv-icon">{icon}</span>
        <span className="chat-conv-copy">
          <strong>{item.title}</strong>
          <span>{formatRelativeTime(item.updatedAt)}</span>
        </span>
      </button>
      <div className="chat-menu">
        <button className="chat-conv-more" type="button" title="更多" onClick={onToggleMenu}>
          {moreIcon}
        </button>
        {menuOpen ? (
          <div className="chat-menu-panel">
            <button type="button" onClick={onRename}>
              重命名
            </button>
            <button type="button" onClick={onMove}>
              移动到文件夹…
            </button>
            <button type="button" onClick={onClear}>
              清空上下文
            </button>
            <button type="button" className="danger" onClick={onDelete}>
              删除
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
