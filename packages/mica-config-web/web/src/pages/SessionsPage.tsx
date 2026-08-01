import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { readSessionContent, readSessionDetails, readSessionsDetails, writeSession } from '../api.js';
import { ContextPane } from '../components/ContextPane.js';
import { ConversationPane } from '../components/ConversationPane.js';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebSessionDetails,
  ConfigWebSessionOption,
  ConfigWebSessionsDetails,
} from '../../../src/shared/types.js';

type SessionTab = 'conversation' | 'context' | 'json';

export function SessionsPage({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const [index, setIndex] = useState<ConfigWebSessionsDetails | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [header, setHeader] = useState<ConfigWebSessionDetails | null>(null);
  const [tab, setTab] = useState<SessionTab>('conversation');
  const [loading, setLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  // Raw JSON editor state is lifted here so tab switches do not lose edits.
  const [rawContent, setRawContent] = useState('');
  const [rawSavedContent, setRawSavedContent] = useState('');
  const [rawLoaded, setRawLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const requestSequence = useRef(0);
  const loadInFlight = useRef(false);
  const selectedIdRef = useRef('');
  const lastUpdatedAtRef = useRef<string | null>(null);
  const dirty = rawContent !== rawSavedContent;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;

  async function loadHeader(id: string, showLoading = false) {
    const sequence = ++requestSequence.current;
    if (!id) {
      setHeader(null);
      return;
    }
    if (showLoading) setSessionLoading(true);
    try {
      const next = await readSessionDetails(id);
      if (requestSequence.current !== sequence) return;
      if (lastUpdatedAtRef.current !== null && lastUpdatedAtRef.current !== next.updatedAt) {
        setDataVersion((value) => value + 1);
      }
      lastUpdatedAtRef.current = next.updatedAt;
      setHeader(next);
      setError(null);
    } catch (loadError) {
      if (requestSequence.current === sequence) setError(formatError(loadError));
    } finally {
      if (showLoading && requestSequence.current === sequence) setSessionLoading(false);
    }
  }

  async function refreshIndex(showLoading: boolean) {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    if (showLoading) setLoading(true);
    try {
      const next = await readSessionsDetails();
      const preferredId = selectedIdRef.current;
      const preferredExists = next.sessions.some((item) => item.id === preferredId);
      const nextId = preferredExists || (dirtyRef.current && preferredId) ? preferredId : (next.sessions[0]?.id ?? '');
      setIndex(next);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      await loadHeader(nextId, showLoading);
      if (!nextId) setError(null);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      loadInFlight.current = false;
      if (showLoading) setLoading(false);
    }
  }

  function selectSession(id: string) {
    if (id === selectedIdRef.current) return;
    if (dirtyRef.current && !window.confirm('当前 Session 有未保存的修改，确定要切换吗？')) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setHeader(null);
    lastUpdatedAtRef.current = null;
    setRawContent('');
    setRawSavedContent('');
    setRawLoaded(false);
    setError(null);
    setVersion((value) => value + 1);
    void loadHeader(id, true);
  }

  async function openRawTab() {
    setTab('json');
    if (rawLoaded || !header) return;
    try {
      const next = await readSessionContent(header.id);
      setRawContent(next.content);
      setRawSavedContent(next.content);
      setRawLoaded(true);
    } catch (loadError) {
      setError(formatError(loadError));
    }
  }

  async function save() {
    if (!header || header.turnState === 'running' || !dirty || saving) return;
    setError(null);
    try {
      JSON.parse(rawContent);
    } catch (parseError) {
      setError(`Session 内容不是有效 JSON：${formatError(parseError)}`);
      return;
    }
    setSaving(true);
    try {
      await writeSession(header.id, rawContent);
      const next = await readSessionDetails(header.id);
      lastUpdatedAtRef.current = next.updatedAt;
      setHeader(next);
      setRawSavedContent(rawContent);
      setRawLoaded(true);
      setSaved(true);
      setDataVersion((value) => value + 1);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void refreshIndex(true);
    const timer = window.setInterval(() => void refreshIndex(false), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);

  const paneKey = `${selectedId}:${version}`;

  return (
    <PageFrame
      title="Sessions"
      path={index?.root}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button
            icon={<RefreshIcon size={15} />}
            title="立即刷新"
            onClick={() => void refreshIndex(true)}
            loading={loading}
          />
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      {!index || index.sessions.length === 0 ? (
        <Empty description="暂无 Session" />
      ) : (
        <div className="session-layout">
          <div className="session-toolbar simple-card">
            <SessionPicker sessions={index.sessions} value={selectedId} onChange={selectSession} />
          </div>

          {sessionLoading && !header ? <div className="session-loading">正在加载 Session…</div> : null}
          {header ? <SessionHeader session={header} /> : null}
          {header ? (
            <section className="simple-card session-tab-card">
              <div className="session-tabs" role="tablist" aria-label="Session 视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'conversation'}
                  className={`session-tab${tab === 'conversation' ? ' session-tab-active' : ''}`}
                  onClick={() => setTab('conversation')}
                >
                  对话记录
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'context'}
                  className={`session-tab${tab === 'context' ? ' session-tab-active' : ''}`}
                  onClick={() => setTab('context')}
                >
                  Context 分析
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'json'}
                  className={`session-tab${tab === 'json' ? ' session-tab-active' : ''}`}
                  onClick={() => void openRawTab()}
                >
                  原始文件
                  {dirty ? <span className="session-tab-dirty">●</span> : null}
                </button>
              </div>
              <div className="session-tab-body">
                {tab === 'conversation' ? (
                  <ConversationPane key={paneKey} sessionId={header.id} refreshToken={dataVersion} />
                ) : null}
                {tab === 'context' ? (
                  <ContextPane key={paneKey} sessionId={header.id} refreshToken={dataVersion} />
                ) : null}
                {tab === 'json' ? (
                  <div className="editor-pane-header session-raw-header">
                    <div>
                      <h3>原始 JSON</h3>
                      <p className="muted-text editor-pane-subtitle">{header.id}</p>
                    </div>
                    <div className="toolbar">
                      {dirty ? <Tag tone="blue">未保存</Tag> : null}
                      {header.turnState === 'running' ? <span className="muted-text">运行中不可保存</span> : null}
                      <Button
                        variant="primary"
                        icon={<SaveIcon size={15} />}
                        disabled={!dirty || header.turnState === 'running'}
                        loading={saving}
                        onClick={() => void save()}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                ) : null}
                {tab === 'json' ? (
                  <div className="editor-host session-raw-editor">
                    <MonacoJsonEditor
                      value={rawContent}
                      language="json"
                      readOnly={saving || header.turnState === 'running'}
                      onChange={setRawContent}
                    />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </PageFrame>
  );
}

function SessionPicker({
  sessions,
  value,
  onChange,
}: {
  sessions: ConfigWebSessionOption[];
  value: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = sessions.find((item) => item.id === value) ?? sessions[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sessions;
    return sessions.filter((item) =>
      `${item.title} ${item.id} ${formatDate(item.updatedAt)}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery, sessions]);
  const selectedIsVisible = filteredSessions.some((item) => item.id === value);
  const CheckIcon = appIcons.check;
  const ChevronDownIcon = appIcons.chevronDown;
  const SearchIcon = appIcons.search;

  useEffect(() => {
    if (!open) return;

    const focusFrame = requestAnimationFrame(() => {
      searchRef.current?.focus();
      activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
    });
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWhenFocusLeaves = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>('.session-picker-trigger')?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('focusin', closeWhenFocusLeaves);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('focusin', closeWhenFocusLeaves);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function togglePicker() {
    setOpen((current) => {
      if (!current) setQuery('');
      return !current;
    });
  }

  function chooseSession(id: string) {
    setOpen(false);
    if (id !== value) onChange(id);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('.session-picker-trigger')?.focus());
  }

  function focusFirstOption(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    rootRef.current?.querySelector<HTMLButtonElement>('.session-picker-option')?.focus();
  }

  function moveOptionFocus(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.session-picker-option') ?? []);
    if (options.length === 0) return;

    event.preventDefault();
    const currentIndex = options.indexOf(event.currentTarget);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : Math.max(0, Math.min(options.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    options[nextIndex]?.focus();
  }

  return (
    <div className="session-selector">
      <span className="session-selector-label">Session</span>
      <div className="session-picker" ref={rootRef}>
        <button
          className="session-picker-trigger"
          type="button"
          title={selected ? `${selected.title} · ${formatDate(selected.updatedAt)}` : undefined}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onClick={togglePicker}
        >
          <span className="session-picker-value">
            <strong>{selected?.title ?? '选择 Session'}</strong>
            {selected ? <span>{formatDate(selected.updatedAt)}</span> : null}
          </span>
          <ChevronDownIcon className="session-picker-chevron" size={16} aria-hidden="true" />
        </button>

        {open ? (
          <div className="session-picker-popover">
            <div className="session-picker-search">
              <SearchIcon size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                type="search"
                aria-label="搜索 Session"
                placeholder="搜索标题、ID 或时间"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={focusFirstOption}
              />
              <span>{filteredSessions.length}</span>
            </div>
            <div className="session-picker-options" id={listboxId} role="listbox" aria-label="Session 列表">
              {filteredSessions.length > 0 ? (
                filteredSessions.map((item, index) => {
                  const active = item.id === value;
                  return (
                    <button
                      className={`session-picker-option ${active ? 'session-picker-option-active' : ''}`}
                      key={item.id}
                      type="button"
                      ref={active ? activeOptionRef : undefined}
                      role="option"
                      aria-selected={active}
                      tabIndex={active || (!selectedIsVisible && index === 0) ? 0 : -1}
                      title={`${item.title}\n${item.id}`}
                      onClick={() => chooseSession(item.id)}
                      onKeyDown={moveOptionFocus}
                    >
                      <span className="session-picker-option-copy">
                        <strong>{item.title}</strong>
                        <span>{formatDate(item.updatedAt)}</span>
                      </span>
                      <span className="session-picker-check">
                        {active ? <CheckIcon size={16} aria-hidden="true" /> : null}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="session-picker-empty">没有匹配的 Session</div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionHeader({ session }: { session: ConfigWebSessionDetails }) {
  const status = presentStatus(session.turnState);
  return (
    <div className="session-summary simple-card">
      <div className="session-summary-title">
        <div>
          <h3 title={session.title}>{session.title}</h3>
          <span>{session.id}</span>
        </div>
        <div className="toolbar">
          <Tag tone={status.tone}>{status.label}</Tag>
          <Tag>{session.role}</Tag>
          <Tag>{session.turnState === 'running' ? '编辑锁定' : 'JSON 可编辑'}</Tag>
        </div>
      </div>
      <div className="simple-list">
        <div className="simple-row">
          <span>Working Directory</span>
          <strong>{session.cwd}</strong>
        </div>
        <div className="simple-row">
          <span>Model</span>
          <strong>
            {session.providerId} · {session.model}
          </strong>
        </div>
        <div className="simple-row">
          <span>Updated</span>
          <strong>{formatDate(session.updatedAt)}</strong>
        </div>
        <div className="simple-row">
          <span>File</span>
          <strong>
            {formatBytes(session.fileSizeBytes)} · {session.messageCount} 条消息 · {session.usageCount} 条用量
          </strong>
        </div>
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function presentStatus(turnState: string): { tone: 'default' | 'green' | 'red' | 'blue'; label: string } {
  switch (turnState) {
    case 'running':
      return { tone: 'blue', label: '运行中' };
    case 'completed':
      return { tone: 'green', label: '已完成' };
    case 'aborted':
      return { tone: 'default', label: '已中止' };
    case 'error':
      return { tone: 'red', label: '错误' };
    default:
      return { tone: 'default', label: turnState };
  }
}
