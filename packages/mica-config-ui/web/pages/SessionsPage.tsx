import { useEffect, useMemo, useRef, useState } from 'react';
import { readSessionContent, readSessionDetails, readSessionsDetails, writeSession } from '../api.js';
import { ContextPane } from '../components/ContextPane.js';
import { ConversationPane } from '../components/ConversationPane.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, SplitView, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { useAutoSave } from '../useAutoSave.js';
import type {
  ConfigWebSessionDetails,
  ConfigWebSessionOption,
  ConfigWebSessionsDetails,
} from '../../src/shared/types.js';

type SessionTab = 'conversation' | 'context' | 'json';

const SESSION_TABS: { id: SessionTab; label: string }[] = [
  { id: 'conversation', label: '对话记录' },
  { id: 'context', label: 'Context 分析' },
  { id: 'json', label: '原始文件' },
];

/**
 * Sessions：左边一列会话、右边看选中的那一条。
 *
 * 以前是「顶部一个会话选择器下拉 + 下面一张摘要卡 + 一张视图卡」：选择器占掉一整行高度，
 * 而真正要看的对话挤在第三块里滚动。列表放进左栏后，切换会话是一行一次点击，
 * 竖排空间全给正文；摘要在详情头部收成一行，不再单独占一张卡。
 */
export function SessionsPage() {
  const [index, setIndex] = useState<ConfigWebSessionsDetails | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [header, setHeader] = useState<ConfigWebSessionDetails | null>(null);
  const [tab, setTab] = useState<SessionTab>('conversation');
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [filter, setFilter] = useState('');

  // Raw JSON editor state is lifted here so tab switches do not lose edits.
  const [rawContent, setRawContent] = useState('');
  const [rawSavedContent, setRawSavedContent] = useState('');
  const [rawLoaded, setRawLoaded] = useState(false);

  const requestSequence = useRef(0);
  const loadInFlight = useRef(false);
  const selectedIdRef = useRef('');
  const lastUpdatedAtRef = useRef<string | null>(null);
  const dirty = rawContent !== rawSavedContent;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const RefreshIcon = appIcons.refresh;
  const SearchIcon = appIcons.search;
  // 半句 JSON 不写盘：本地先解析一遍，解析不过就只显示提示，等内容合法再落盘。
  const jsonError = useMemo(() => {
    if (!dirty) return null;
    try {
      JSON.parse(rawContent);
      return null;
    } catch (parseError) {
      return formatError(parseError);
    }
  }, [dirty, rawContent]);
  const sessionId = header?.id ?? '';
  // 运行中的会话有 turn lease，写盘会和正在跑的 turn 抢，等它结束再写。
  const running = header?.turnState === 'running';

  const autoSave = useAutoSave<{ id: string; content: string }, ConfigWebSessionDetails>({
    save: async ({ id, content }) => {
      await writeSession(id, content);
      return readSessionDetails(id);
    },
    onSaved: (next, saved) => {
      lastUpdatedAtRef.current = next.updatedAt;
      setHeader(next);
      setRawSavedContent(saved.content);
      setDataVersion((value) => value + 1);
    },
  });
  const { schedule, flush } = autoSave;

  // turn 结束时补一次：运行中敲的内容被 editRawContent 直接跳过，没人再催它写盘。
  const latestRawRef = useRef({ rawContent, rawSavedContent, rawLoaded, sessionId, jsonError });
  latestRawRef.current = { rawContent, rawSavedContent, rawLoaded, sessionId, jsonError };

  useEffect(() => {
    if (running) return;
    const latest = latestRawRef.current;
    if (!latest.rawLoaded || !latest.sessionId) return;
    if (latest.rawContent === latest.rawSavedContent || latest.jsonError) return;
    schedule({ id: latest.sessionId, content: latest.rawContent });
  }, [running, schedule]);

  /**
   * 改动当场登记写盘。
   *
   * 不用 effect 兜：改完立刻切会话时，卸载和这次改动落在同一批更新里，被卸载的组件不会
   * 再跑 effect，那一批改动就没人登记了。半句 JSON 与运行中的会话先不写。
   */
  function editRawContent(next: string) {
    setRawContent(next);
    if (!rawLoaded || !sessionId || running) return;
    if (next === rawSavedContent) return;
    try {
      JSON.parse(next);
    } catch {
      return;
    }
    schedule({ id: sessionId, content: next });
  }

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

  async function selectSession(id: string) {
    if (id === selectedIdRef.current) return;
    // 先把路上那份改动写完再换，切换不丢正在编辑的内容。
    await flush();
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

  useEffect(() => {
    void refreshIndex(true);
    const timer = window.setInterval(() => void refreshIndex(false), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const paneKey = `${selectedId}:${version}`;
  const sessions = index?.sessions ?? [];
  const visibleSessions = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);

  return (
    <PageFrame
      title="Sessions"
      path={index?.root}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
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
      {autoSave.error ? <Alert message={autoSave.error} /> : null}
      {loading && !index ? (
        <div className="page-loading">正在加载 Sessions…</div>
      ) : !index ? null : sessions.length === 0 ? (
        <Empty description="还没有任何会话：跑一次对话就会出现在这里" />
      ) : (
        <div className="session-page">
          <SplitView
            rail={
              <>
                <div className="split-rail-head">
                  <div className="split-rail-filter">
                    <SearchIcon size={14} aria-hidden="true" />
                    <input
                      value={filter}
                      type="search"
                      aria-label="搜索会话"
                      placeholder="搜索标题、目录或模型"
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </div>
                </div>
                <div className="split-rail-list" role="listbox" aria-label="会话列表">
                  {visibleSessions.length === 0 ? (
                    <p className="split-rail-empty">没有匹配的会话</p>
                  ) : (
                    visibleSessions.map((item) => (
                      <SessionRow
                        key={item.id}
                        session={item}
                        active={item.id === selectedId}
                        onSelect={() => void selectSession(item.id)}
                      />
                    ))
                  )}
                </div>
              </>
            }
          >
            {sessionLoading && !header ? (
              <div className="page-loading">正在加载 Session…</div>
            ) : header ? (
              <div className="session-detail">
                <SessionHead session={header} />
                <div className="session-tabs" role="tablist" aria-label="Session 视图">
                  {SESSION_TABS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.id}
                      className={`session-tab${tab === item.id ? ' session-tab-active' : ''}`}
                      onClick={() => (item.id === 'json' ? void openRawTab() : setTab(item.id))}
                    >
                      {item.label}
                      {item.id === 'json' && dirty ? <span className="session-tab-dirty">●</span> : null}
                    </button>
                  ))}
                  <span className="session-tabs-tail">
                    {tab === 'json' ? (
                      <>
                        {running ? <span className="muted-text">运行中，暂停写盘</span> : null}
                        {jsonError && !running ? <Tag tone="red">JSON 未写完</Tag> : null}
                        {dirty && !jsonError && !running ? <Tag tone="blue">待写入</Tag> : null}
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="session-tab-body">
                  {tab === 'conversation' ? (
                    <ConversationPane key={paneKey} sessionId={header.id} refreshToken={dataVersion} />
                  ) : null}
                  {tab === 'context' ? (
                    <ContextPane key={paneKey} sessionId={header.id} refreshToken={dataVersion} />
                  ) : null}
                  {tab === 'json' ? (
                    <div className="editor-host session-raw-editor">
                      <JsonEditor value={rawContent} language="json" readOnly={running} onChange={editRawContent} />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="page-loading">正在加载 Session…</div>
            )}
          </SplitView>
        </div>
      )}
    </PageFrame>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: ConfigWebSessionOption;
  active: boolean;
  onSelect(): void;
}) {
  const state = presentStatus(session.turnState ?? '');
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`split-item${active ? ' is-active' : ''}`}
      title={`${session.title}\n${session.cwd ?? ''}\n${session.id}`}
      onClick={onSelect}
    >
      <span className="split-item-copy">
        <span className="split-item-title">{session.title}</span>
        <span className="split-item-meta">{sessionMeta(session)}</span>
      </span>
      {state ? (
        <span className="split-item-trailing">
          <span className={`session-state-dot is-${state.tone}`} title={state.label} />
        </span>
      ) : null}
    </button>
  );
}

/** 详情头部：标题 + 身份行 + 一行事实。摘要不再是单独一张卡，避免它比正文还抢眼。 */
function SessionHead({ session }: { session: ConfigWebSessionDetails }) {
  const status = presentStatus(session.turnState);
  return (
    <header className="session-detail-head">
      <div className="session-detail-title">
        <h2 title={session.title}>{session.title}</h2>
        <Tag tone={status.tone} dot>
          {status.label}
        </Tag>
      </div>
      <p className="session-detail-path" title={session.cwd}>
        {shortenDir(session.cwd)}
      </p>
      <dl className="session-detail-facts">
        <MetaFact label="模型" value={`${session.providerId} · ${session.model}`} />
        <MetaFact label="角色" value={session.role} />
        <MetaFact label="更新" value={formatDate(session.updatedAt)} />
        <MetaFact
          label="文件"
          value={`${formatBytes(session.fileSizeBytes)} · ${session.messageCount} 条消息 · ${session.usageCount} 条用量`}
        />
      </dl>
    </header>
  );
}

function MetaFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-detail-fact">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

/** 列表行的第二行：目录末两级 · 模型。两者都没有时退回更新时间。 */
function sessionMeta(session: ConfigWebSessionOption): string {
  const parts = [tailDir(session.cwd), session.model].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : formatDate(session.updatedAt);
}

function filterSessions(sessions: ConfigWebSessionOption[], filter: string): ConfigWebSessionOption[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return sessions;
  return sessions.filter((session) =>
    `${session.title} ${session.id} ${session.cwd ?? ''} ${session.model ?? ''}`.toLocaleLowerCase().includes(query),
  );
}

/** 目录末两级：面板里只需要认出「哪个项目」。 */
function tailDir(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts.slice(-2).join('/');
}

function shortenDir(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 4) return cwd;
  return `…/${parts.slice(-4).join('/')}`;
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
      return { tone: 'default', label: turnState || '未知' };
  }
}
