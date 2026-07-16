import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { readSessionDetails, readSessionsDetails } from '../api.js';
import { ConversationView } from '../components/ConversationView.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebSessionDetails,
  ConfigWebSessionOption,
  ConfigWebSessionsDetails,
} from '../../../src/shared/types.js';

type SessionView = 'raw' | 'conversation';

export function SessionsPage() {
  const [index, setIndex] = useState<ConfigWebSessionsDetails | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [session, setSession] = useState<ConfigWebSessionDetails | null>(null);
  const [view, setView] = useState<SessionView>('raw');
  const [loading, setLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const selectedIdRef = useRef('');
  const RefreshIcon = appIcons.refresh;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const next = await readSessionsDetails();
      const preferredId = selectedIdRef.current;
      const nextId = next.sessions.some((item) => item.id === preferredId) ? preferredId : (next.sessions[0]?.id ?? '');
      setIndex(next);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      await loadSession(nextId);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadSession(id: string) {
    const sequence = ++requestSequence.current;
    setSession(null);
    if (!id) return;
    setSessionLoading(true);
    setError(null);
    try {
      const next = await readSessionDetails(id);
      if (requestSequence.current === sequence) setSession(next);
    } catch (loadError) {
      if (requestSequence.current === sequence) setError(formatError(loadError));
    } finally {
      if (requestSequence.current === sequence) setSessionLoading(false);
    }
  }

  function selectSession(id: string) {
    selectedIdRef.current = id;
    setSelectedId(id);
    void loadSession(id);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <PageFrame
      title="Sessions"
      path={index?.root}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      {!index || index.sessions.length === 0 ? (
        <Empty description="暂无 Session" />
      ) : (
        <div className="session-layout">
          <div className="session-toolbar simple-card">
            <SessionPicker sessions={index.sessions} value={selectedId} onChange={selectSession} />
            <div className="session-view-toggle" role="group" aria-label="Session 查看方式">
              <Button
                variant={view === 'raw' ? 'primary' : 'default'}
                pressed={view === 'raw'}
                onClick={() => setView('raw')}
              >
                原始数据
              </Button>
              <Button
                variant={view === 'conversation' ? 'primary' : 'default'}
                pressed={view === 'conversation'}
                onClick={() => setView('conversation')}
              >
                可视化查看
              </Button>
            </div>
          </div>

          {sessionLoading ? <div className="session-loading">正在加载 Session…</div> : null}
          {session ? <SessionHeader session={session} /> : null}
          {session && view === 'raw' ? (
            <pre className="code-preview session-preview">
              <code>{session.content}</code>
            </pre>
          ) : null}
          {session && view === 'conversation' ? <ConversationView details={session.conversation} /> : null}
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
  return (
    <div className="session-summary simple-card">
      <div className="session-summary-title">
        <div>
          <h3 title={session.title}>{session.title}</h3>
          <span>{session.id}</span>
        </div>
        <div className="toolbar">
          <Tag tone={session.turnState === 'completed' ? 'green' : session.turnState === 'error' ? 'red' : 'blue'}>
            {session.turnState}
          </Tag>
          <Tag>{session.role}</Tag>
          <Tag>只读</Tag>
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
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
