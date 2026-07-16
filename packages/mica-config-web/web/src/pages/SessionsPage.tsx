import { useEffect, useRef, useState } from 'react';
import { readSessionDetails, readSessionsDetails } from '../api.js';
import { ConversationView } from '../components/ConversationView.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import type { ConfigWebSessionDetails, ConfigWebSessionsDetails } from '../../../src/shared/types.js';

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
  const RefreshIcon = appIcons.refresh;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const next = await readSessionsDetails();
      const nextId = next.sessions.some((item) => item.id === selectedId) ? selectedId : (next.sessions[0]?.id ?? '');
      setIndex(next);
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
            <label className="session-selector">
              <span>Session</span>
              <select value={selectedId} onChange={(event) => selectSession(event.target.value)}>
                {index.sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {formatDate(item.updatedAt)}
                  </option>
                ))}
              </select>
            </label>
            <div className="session-view-toggle" aria-label="Session 查看方式">
              <Button variant={view === 'raw' ? 'primary' : 'default'} onClick={() => setView('raw')}>
                原始数据
              </Button>
              <Button variant={view === 'conversation' ? 'primary' : 'default'} onClick={() => setView('conversation')}>
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

function SessionHeader({ session }: { session: ConfigWebSessionDetails }) {
  return (
    <div className="session-summary simple-card">
      <div className="session-summary-title">
        <div>
          <h3>{session.title}</h3>
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
