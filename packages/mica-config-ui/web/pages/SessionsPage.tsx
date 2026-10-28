import { useEffect, useMemo, useRef, useState } from 'react';
import { readSessionsDetails } from '../api.js';
import { PageFrame } from '../components/PageFrame.js';
import { SessionDetailView } from '../components/SessionDetailView.js';
import { Alert, Button, Empty, SplitView } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebSessionOption, ConfigWebSessionsDetails } from '../../src/shared/types.js';

type SessionIndex = ConfigWebSessionsDetails;

/**
 * Sessions：左边一列会话、右边看选中的那一条。
 *
 * 右栏由 `SessionDetailView` 负责（对话记录 / Context 分析 / 原始文件），与桌面端的会话详情、
 * 上下文弹窗是同一个组件——这里只管列表、选中与刷新，不再自己拼详情页。
 */
export function SessionsPage() {
  const [index, setIndex] = useState<SessionIndex | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const loadInFlight = useRef(false);
  const selectedIdRef = useRef('');

  const RefreshIcon = appIcons.refresh;
  const SearchIcon = appIcons.search;

  async function refreshIndex(showLoading: boolean) {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    if (showLoading) setLoading(true);
    try {
      const next = await readSessionsDetails();
      const preferredId = selectedIdRef.current;
      const preferredExists = next.sessions.some((item) => item.id === preferredId);
      const nextId = preferredExists ? preferredId : (next.sessions[0]?.id ?? '');
      setIndex(next);
      selectedIdRef.current = nextId;
      setSelectedId(nextId);
      setError(null);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      loadInFlight.current = false;
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    void refreshIndex(true);
    const timer = window.setInterval(() => void refreshIndex(false), 3000);
    return () => window.clearInterval(timer);
  }, []);

  function selectSession(id: string) {
    if (id === selectedIdRef.current) return;
    selectedIdRef.current = id;
    setSelectedId(id);
  }

  const sessions = index?.sessions ?? [];
  const visibleSessions = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);

  return (
    <PageFrame
      title="Sessions"
      description="本机保存的会话快照：可以查看摘要、改标题、导出与删除"
      path={index?.root}
      actions={
        <div className="toolbar">
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
                        onSelect={() => selectSession(item.id)}
                      />
                    ))
                  )}
                </div>
              </>
            }
          >
            {selectedId ? (
              // 换会话就重新挂载：上一个会话的页签、滚动与未保存草稿不该带过来。
              <SessionDetailView key={selectedId} sessionId={selectedId} />
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

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
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
