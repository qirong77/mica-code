import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  abortSession,
  createSession,
  fetchMachines,
  fetchSession,
  fetchSessions,
  runOnSession,
  updateSessionCwd,
  type MachineInfo,
  type SessionSummary,
  type StoredSession,
  type SyncEvent,
} from './api';
import { Conversation } from './Conversation';
import { appIcons } from './icons';
import { NewSessionModal } from './NewSessionModal';
import { applyEvent, mergeSessionMessages, messagesFromSession, type UiMessage } from './render';
import { Sidebar } from './Sidebar';
import { useSse } from './useSse';

const REFRESH_MS = 30_000;
const SESSION_REFRESH_MS = 30_000;

type Route = { machineId: string | null; sessionId: string | null };
type SessionData = { machine: MachineInfo; session: StoredSession; snapshotSeq?: number };
type FetchKind = 'initial' | 'poll' | 'terminal';

const EMPTY_ROUTE: Route = { machineId: null, sessionId: null };
const TERMINAL_TURN_STATES = new Set(['completed', 'aborted', 'error']);

function parseHash(): Route {
  const match = /^#\/m\/([^/]+)\/s\/([^/]+)$/.exec(window.location.hash);
  if (match) return { machineId: match[1], sessionId: match[2] };
  return EMPTY_ROUTE;
}

function sameRoute(left: Route, right: Route): boolean {
  return left.machineId === right.machineId && left.sessionId === right.sessionId;
}

function compareUpdatedAt(left: StoredSession, right: StoredSession): number {
  if (typeof left.revision === 'number' || typeof right.revision === 'number') {
    return Math.sign((left.revision ?? 0) - (right.revision ?? 0));
  }
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return Math.sign(leftTime - rightTime);
  return left.updatedAt.localeCompare(right.updatedAt);
}

function storedSessionFrom(value: unknown): StoredSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<StoredSession>;
  if (
    typeof session.id !== 'string' ||
    typeof session.title !== 'string' ||
    typeof session.updatedAt !== 'string' ||
    typeof session.cwd !== 'string' ||
    typeof session.turnState !== 'string' ||
    !session.snapshot ||
    typeof session.snapshot !== 'object'
  ) {
    return null;
  }
  return session as StoredSession;
}

export function App() {
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [sessionsByMachine, setSessionsByMachine] = useState<Map<string, SessionSummary[]>>(new Map());
  const [refreshing, setRefreshing] = useState(false);

  const [route, setRoute] = useState(parseHash);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newSessionFor, setNewSessionFor] = useState<string | null>(null);
  const [newSessionError, setNewSessionError] = useState('');
  const [newSessionSubmitting, setNewSessionSubmitting] = useState(false);
  const [cwdSwitching, setCwdSwitching] = useState(false);
  const [cwdError, setCwdError] = useState('');
  const MenuIcon = appIcons.menu;

  const runningRef = useRef(running);
  const machinesRef = useRef<MachineInfo[]>([]);
  const routeRef = useRef(route);
  const routeRevisionRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const initialSinceRef = useRef(0);
  // Latest snapshot watermark per session, from the sessions list poll, so a
  // switch can open SSE immediately without waiting for the detail fetch.
  const snapshotSeqBySessionRef = useRef(new Map<string, number>());
  const sessionDataRef = useRef<SessionData | null>(null);
  const latestSessionRef = useRef<StoredSession | null>(null);
  // Sessions just created via the web UI: their detail fetch 404s until the
  // daemon persists the first snapshot, so suppress the error and wait for the
  // first SSE event instead.
  const pendingSessionsRef = useRef(new Set<string>());
  runningRef.current = running;
  machinesRef.current = machines;

  const setRemoteRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunning(value);
  }, []);

  const clearSelectedSession = useCallback(
    (error = '') => {
      sessionDataRef.current = null;
      latestSessionRef.current = null;
      snapshotRevisionRef.current += 1;
      setSessionData(null);
      setMessages([]);
      setRemoteRunning(false);
      setSessionError(error);
    },
    [setRemoteRunning],
  );

  const selectRoute = useCallback(
    (next: Route) => {
      if (sameRoute(routeRef.current, next)) return;
      routeRef.current = next;
      routeRevisionRef.current += 1;
      if (next.sessionId) {
        // Open SSE immediately from the list watermark; the detail fetch
        // refines it when it arrives.
        initialSinceRef.current = snapshotSeqBySessionRef.current.get(`${next.machineId}/${next.sessionId}`) ?? 0;
      }
      setCwdError('');
      clearSelectedSession();
      setRoute(next);
    },
    [clearSelectedSession],
  );

  useEffect(() => {
    const onHashChange = () => selectRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [selectRoute]);

  // ── machines / sessions polling ──
  const refreshMachines = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await fetchMachines();
      setMachines(next);
      const map = new Map<string, SessionSummary[]>();
      await Promise.all(
        next.map(async (machine) => {
          try {
            const { sessions } = await fetchSessions(machine.id);
            map.set(machine.id, sessions);
            for (const session of sessions) {
              if (typeof session.snapshotSeq === 'number') {
                snapshotSeqBySessionRef.current.set(`${machine.id}/${session.id}`, session.snapshotSeq);
              }
            }
          } catch {
            map.set(machine.id, []);
          }
        }),
      );
      setSessionsByMachine(map);
    } catch {
      // Machines polling is best-effort; the next interval retries.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshMachines();
    const timer = setInterval(() => void refreshMachines(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshMachines]);

  const publishSession = useCallback(
    (data: SessionData, replaceMessages = true) => {
      const wasRemoteRunning = runningRef.current;
      const finished = data.session.turnState !== 'running';
      latestSessionRef.current = data.session;
      sessionDataRef.current = data;
      snapshotRevisionRef.current += 1;
      setSessionData(data);
      if (finished) setRemoteRunning(false);
      // Live `session` events carry metadata only (no snapshot payload), so
      // they must not replace the message list built from streamed events.
      if (replaceMessages && (!wasRemoteRunning || finished)) {
        setMessages((current) =>
          mergeSessionMessages(current, messagesFromSession(data.session.snapshot.conversationMessages)),
        );
      }
    },
    [setRemoteRunning],
  );

  const acceptFetchedSession = useCallback(
    (requestedRoute: Route, data: SessionData, kind: FetchKind) => {
      if (
        !sameRoute(routeRef.current, requestedRoute) ||
        data.machine.id !== requestedRoute.machineId ||
        data.session.id !== requestedRoute.sessionId
      ) {
        return;
      }

      initialSinceRef.current = data.snapshotSeq ?? 0;
      const latest = latestSessionRef.current;
      if (latest?.id === data.session.id) {
        const comparison = compareUpdatedAt(data.session, latest);
        const staleRunningSnapshot =
          TERMINAL_TURN_STATES.has(latest.turnState) && data.session.turnState === 'running' && comparison <= 0;
        const shouldKeepLatest = comparison < 0 || staleRunningSnapshot || (kind !== 'terminal' && comparison === 0);
        if (shouldKeepLatest) {
          if (!sessionDataRef.current) publishSession({ machine: data.machine, session: latest });
          return;
        }
      }

      publishSession(data);
    },
    [publishSession],
  );

  const updateTurnState = useCallback((requestedRoute: Route, turnState: string) => {
    if (!sameRoute(routeRef.current, requestedRoute)) return;
    const latest = latestSessionRef.current;
    if (latest?.id === requestedRoute.sessionId) {
      latestSessionRef.current = { ...latest, turnState };
      snapshotRevisionRef.current += 1;
    }
    const current = sessionDataRef.current;
    if (current?.session.id === requestedRoute.sessionId) {
      const next = { ...current, session: { ...current.session, turnState } };
      sessionDataRef.current = next;
      setSessionData(next);
    }
  }, []);

  const refetchSession = useCallback(
    async (requestedRoute: Route, kind: FetchKind) => {
      if (!requestedRoute.machineId || !requestedRoute.sessionId) return;
      const routeRevision = routeRevisionRef.current;
      const snapshotRevision = snapshotRevisionRef.current;
      try {
        const data = await fetchSession(requestedRoute.machineId, requestedRoute.sessionId);
        if (routeRevision !== routeRevisionRef.current) return;
        const latest = latestSessionRef.current;
        if (
          snapshotRevision !== snapshotRevisionRef.current &&
          sessionDataRef.current &&
          latest?.id === data.session.id &&
          compareUpdatedAt(data.session, latest) <= 0
        ) {
          return;
        }
        acceptFetchedSession(requestedRoute, data, kind);
      } catch (error) {
        if (
          routeRevision === routeRevisionRef.current &&
          kind === 'initial' &&
          sameRoute(routeRef.current, requestedRoute) &&
          !sessionDataRef.current
        ) {
          if (
            requestedRoute.machineId &&
            requestedRoute.sessionId &&
            pendingSessionsRef.current.has(`${requestedRoute.machineId}/${requestedRoute.sessionId}`)
          ) {
            // The daemon has not persisted the freshly created session yet;
            // the first SSE event will surface it.
            return;
          }
          setSessionError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [acceptFetchedSession],
  );

  const acceptEventSession = useCallback(
    (requestedRoute: Route, snapshot: StoredSession) => {
      if (!sameRoute(routeRef.current, requestedRoute) || snapshot.id !== requestedRoute.sessionId) return;
      const latest = latestSessionRef.current;
      if (latest?.id === snapshot.id) {
        const comparison = compareUpdatedAt(snapshot, latest);
        if (
          comparison < 0 ||
          (TERMINAL_TURN_STATES.has(latest.turnState) && snapshot.turnState === 'running' && comparison <= 0)
        ) {
          return;
        }
      }

      pendingSessionsRef.current.delete(`${requestedRoute.machineId}/${requestedRoute.sessionId}`);
      latestSessionRef.current = snapshot;
      const current = sessionDataRef.current;
      if (current) {
        // Live `session` events are lightweight metadata without a snapshot
        // payload: update the header state but keep the message list built
        // from streamed events. When the turn settles (e.g. a local terminal
        // turn completing without deltas) fetch the authoritative snapshot.
        publishSession({ ...current, session: snapshot }, false);
        if (TERMINAL_TURN_STATES.has(snapshot.turnState)) void refetchSession(requestedRoute, 'terminal');
      } else {
        // Freshly created session: the light snapshot has no message payload,
        // so render the header/input immediately and keep the message list
        // built from streamed events.
        const machine = machinesRef.current.find((item) => item.id === requestedRoute.machineId);
        if (machine) {
          publishSession({ machine, session: snapshot }, false);
          if (TERMINAL_TURN_STATES.has(snapshot.turnState)) void refetchSession(requestedRoute, 'terminal');
        } else {
          snapshotRevisionRef.current += 1;
          if (snapshot.turnState !== 'running') setRemoteRunning(false);
        }
      }
    },
    [publishSession, refetchSession, setRemoteRunning],
  );

  // ── load and periodically heal the selected session ──
  useEffect(() => {
    if (!route.machineId || !route.sessionId) return;
    clearSelectedSession();
    const requestedRoute = { ...route };
    void refetchSession(requestedRoute, 'initial');
  }, [clearSelectedSession, refetchSession, route.machineId, route.sessionId]);

  useEffect(() => {
    if (!route.machineId || !route.sessionId) return;
    const requestedRoute = { ...route };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await refetchSession(requestedRoute, 'poll');
      if (!stopped) timer = setTimeout(() => void poll(), SESSION_REFRESH_MS);
    };
    timer = setTimeout(() => void poll(), SESSION_REFRESH_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refetchSession, route.machineId, route.sessionId]);

  const handleEvent = useCallback(
    (event: SyncEvent, machineId: string, sessionId: string) => {
      const requestedRoute = { machineId, sessionId };
      if (!sameRoute(routeRef.current, requestedRoute)) return;

      if (event.type === 'turn') {
        const state = typeof event.state === 'string' ? event.state : null;
        if (state === 'running') {
          setRemoteRunning(true);
          updateTurnState(requestedRoute, state);
        } else if (state && TERMINAL_TURN_STATES.has(state)) {
          setRemoteRunning(false);
          updateTurnState(requestedRoute, state);
        }
        setMessages((current) => applyEvent(current, event));
        if (state && TERMINAL_TURN_STATES.has(state)) void refetchSession(requestedRoute, 'terminal');
        return;
      }
      if (event.type === 'run_rejected') {
        setRemoteRunning(false);
        setMessages((current) => applyEvent(current, event));
        return;
      }
      if (event.type === 'cwd_update') {
        if (event.ok === false) {
          setCwdError(String(event.error ?? '切换工作目录失败'));
        } else if (typeof event.cwd === 'string') {
          setCwdError('');
          // The daemon persisted the new cwd; adopt it (also covers switching
          // from another tab while this one is open).
          setSessionData((current) =>
            current && sameRoute(routeRef.current, requestedRoute)
              ? { ...current, session: { ...current.session, cwd: event.cwd as string } }
              : current,
          );
        }
        return;
      }
      if (event.type === 'session_removed') {
        setSessionsByMachine((current) => {
          const next = new Map(current);
          next.set(
            machineId,
            (next.get(machineId) ?? []).filter((session) => session.id !== sessionId),
          );
          return next;
        });
        clearSelectedSession('会话已删除');
        routeRef.current = EMPTY_ROUTE;
        routeRevisionRef.current += 1;
        setRoute(EMPTY_ROUTE);
        window.location.hash = '';
        return;
      }
      if (event.type === 'session') {
        const snapshot = storedSessionFrom(event.session);
        if (snapshot) acceptEventSession(requestedRoute, snapshot);
        return;
      }
      setMessages((current) => applyEvent(current, event));
    },
    [acceptEventSession, clearSelectedSession, refetchSession, setRemoteRunning, updateTurnState],
  );

  // SSE opens immediately on switch, starting from the watermark the sessions
  // list carried (refined by the detail fetch when it arrives), so switching
  // never shows a disconnected window.
  const sessionReady = Boolean(route.machineId && route.sessionId);
  const { connected, connecting } = useSse(
    route.machineId,
    route.sessionId,
    handleEvent,
    sessionReady,
    initialSinceRef,
  );

  // ── actions ──
  const handleCreateSession = async (machineId: string, text: string, cwd?: string) => {
    setNewSessionError('');
    setNewSessionSubmitting(true);
    try {
      const { sessionId } = await createSession(machineId, text, cwd);
      pendingSessionsRef.current.add(`${machineId}/${sessionId}`);
      setNewSessionFor(null);
      selectRoute({ machineId, sessionId });
      window.location.hash = `#/m/${encodeURIComponent(machineId)}/s/${encodeURIComponent(sessionId)}`;
      void refreshMachines();
    } catch (error) {
      if (!newSessionFor) return;
      setNewSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewSessionSubmitting(false);
    }
  };

  const send = async (text: string) => {
    const requestedRoute = { ...routeRef.current };
    if (!requestedRoute.machineId || !requestedRoute.sessionId) return;
    setRemoteRunning(true);
    setMessages((current) => applyEvent(current, { seq: 0, ts: Date.now(), type: 'user_input', text } as SyncEvent));
    try {
      await runOnSession(requestedRoute.machineId, requestedRoute.sessionId, text);
    } catch (error) {
      if (!sameRoute(routeRef.current, requestedRoute)) return;
      setRemoteRunning(false);
      setMessages((current) =>
        applyEvent(current, {
          seq: 0,
          ts: Date.now(),
          type: 'run_rejected',
          message: error instanceof Error ? error.message : String(error),
        } as SyncEvent),
      );
    }
  };

  const abort = async () => {
    const requestedRoute = { ...routeRef.current };
    if (!requestedRoute.machineId || !requestedRoute.sessionId) return;
    try {
      await abortSession(requestedRoute.machineId, requestedRoute.sessionId);
    } catch (error) {
      if (!sameRoute(routeRef.current, requestedRoute)) return;
      setMessages((current) =>
        applyEvent(current, {
          seq: 0,
          ts: Date.now(),
          type: 'run_rejected',
          message: `中止请求失败: ${error instanceof Error ? error.message : String(error)}`,
        } as SyncEvent),
      );
    }
  };

  // Recently used directories on this machine (from the sessions list), for
  // the cwd switcher next to the send button. Most recent first.
  const cwdCandidates = useMemo(() => {
    if (!route.machineId) return [];
    const sessions = sessionsByMachine.get(route.machineId) ?? [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const summary of [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      if (!summary.cwd || seen.has(summary.cwd)) continue;
      seen.add(summary.cwd);
      result.push(summary.cwd);
      if (result.length >= 10) break;
    }
    return result;
  }, [sessionsByMachine, route.machineId]);

  const handleSelectCwd = async (cwd: string) => {
    const requestedRoute = { ...routeRef.current };
    if (!requestedRoute.machineId || !requestedRoute.sessionId) return;
    const { machineId, sessionId } = requestedRoute;
    setCwdError('');
    setCwdSwitching(true);
    try {
      await updateSessionCwd(machineId, sessionId, cwd);
      // Optimistic update; the SSE session event will confirm the persisted cwd.
      setSessionData((current) =>
        current && sameRoute(routeRef.current, requestedRoute)
          ? { ...current, session: { ...current.session, cwd } }
          : current,
      );
      setSessionsByMachine((current) => {
        const next = new Map(current);
        next.set(
          machineId,
          (next.get(machineId) ?? []).map((summary) => (summary.id === sessionId ? { ...summary, cwd } : summary)),
        );
        return next;
      });
    } catch (error) {
      if (!sameRoute(routeRef.current, requestedRoute)) return;
      setCwdError(error instanceof Error ? error.message : String(error));
    } finally {
      setCwdSwitching(false);
    }
  };

  // ── render ──
  return (
    <div className="app-shell">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        machines={machines}
        sessionsByMachine={sessionsByMachine}
        selectedMachineId={route.machineId}
        selectedSessionId={route.sessionId}
        open={sidebarOpen}
        onSelectSession={(machineId, sessionId) => {
          setSidebarOpen(false);
          const next = sessionId ? { machineId, sessionId } : EMPTY_ROUTE;
          selectRoute(next);
          window.location.hash = sessionId
            ? `#/m/${encodeURIComponent(machineId)}/s/${encodeURIComponent(sessionId)}`
            : '';
        }}
        onNewSession={(machineId) => {
          setSidebarOpen(false);
          setNewSessionError('');
          setNewSessionFor(machineId);
        }}
        onRefresh={() => void refreshMachines()}
        refreshing={refreshing}
      />
      {sessionData ? (
        <Conversation
          machine={sessionData.machine}
          session={sessionData.session}
          messages={messages}
          running={running}
          connected={connected}
          connecting={connecting}
          cwdCandidates={cwdCandidates}
          cwdSwitching={cwdSwitching}
          cwdError={cwdError}
          onSend={(text) => void send(text)}
          onAbort={() => void abort()}
          onSelectCwd={(cwd) => void handleSelectCwd(cwd)}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      ) : route.sessionId ? (
        <main className="welcome">
          <div className="welcome-topbar">
            <button
              className="menu-button"
              onClick={() => setSidebarOpen(true)}
              title="机器与会话"
              aria-label="打开机器与会话列表"
            >
              <MenuIcon size={18} />
            </button>
          </div>
          {sessionError ? (
            <div className="notice-block error">{sessionError}</div>
          ) : (
            <div className="welcome-loading">
              <div className="spinner" />
              <p>加载会话中…</p>
            </div>
          )}
        </main>
      ) : (
        <main className="welcome">
          <div className="welcome-topbar">
            <button
              className="menu-button"
              onClick={() => setSidebarOpen(true)}
              title="机器与会话"
              aria-label="打开机器与会话列表"
            >
              <MenuIcon size={18} />
            </button>
          </div>
          {sessionError ? (
            <div className="notice-block error">{sessionError}</div>
          ) : (
            <>
              <h1>选择一个会话</h1>
              <p className="welcome-hint">
                <span className="desktop-only">左侧选择机器和会话，</span>
                <span className="mobile-only">点击左上角按钮选择机器和会话，</span>
                查看历史对话或继续对话。
              </p>
              <div className="welcome-stats">
                <div className="stat-card">
                  <div className="stat-value">{machines.length}</div>
                  <div className="stat-label">机器</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{machines.filter((machine) => machine.online).length}</div>
                  <div className="stat-label">在线</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">
                    {[...sessionsByMachine.values()].reduce((sum, sessions) => sum + sessions.length, 0)}
                  </div>
                  <div className="stat-label">会话</div>
                </div>
              </div>
            </>
          )}
        </main>
      )}
      {newSessionFor && (
        <NewSessionModal
          machines={machines}
          initialMachineId={newSessionFor}
          error={newSessionError}
          submitting={newSessionSubmitting}
          onClose={() => {
            if (newSessionSubmitting) return;
            setNewSessionFor(null);
            setNewSessionError('');
          }}
          onSubmit={(machineId, text, cwd) => void handleCreateSession(machineId, text, cwd)}
        />
      )}
    </div>
  );
}
