import type { MachineInfo, SessionSummary, StoredSession } from '@packages/mica-sync-protocol/index.js';

export type { MachineInfo, SessionSummary, StoredSession } from '@packages/mica-sync-protocol/index.js';
export type { SyncEvent } from '@packages/mica-sync-protocol/index.js';

// The page may be hosted under a sub-path (e.g. /mica/ via nginx). Absolute
// /api paths would then miss the proxy, so resolve against the Vite base.
const API_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}/api${path}`;
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new Error(message);
  }
  // Any 2xx response must be valid JSON; otherwise the shape is broken and
  // callers must see an error instead of silently receiving `undefined`.
  return JSON.parse(text) as T;
}

export async function fetchMachines(): Promise<MachineInfo[]> {
  const data = await api<{ machines: MachineInfo[] }>('/machines');
  return data.machines ?? [];
}

export async function fetchSessions(machineId: string): Promise<{ machine: MachineInfo; sessions: SessionSummary[] }> {
  const data = await api<{ machine: MachineInfo; sessions?: SessionSummary[] }>(
    `/machines/${encodeURIComponent(machineId)}/sessions`,
  );
  return { machine: data.machine, sessions: data.sessions ?? [] };
}

export async function fetchSession(
  machineId: string,
  sessionId: string,
): Promise<{ machine: MachineInfo; session: StoredSession; snapshotSeq: number }> {
  const data = await api<{ machine: MachineInfo; session?: StoredSession; snapshotSeq?: number }>(
    `/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!data.session) throw new Error('会话不存在');
  return { machine: data.machine, session: data.session, snapshotSeq: data.snapshotSeq ?? 0 };
}

export async function runOnSession(machineId: string, sessionId: string, text: string): Promise<void> {
  await api(`/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/run`, {
    method: 'POST',
    body: { text },
  });
}

/** Asks the daemon on `machineId` to switch the session's working directory. */
export async function updateSessionCwd(machineId: string, sessionId: string, cwd: string): Promise<void> {
  await api(`/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/cwd`, {
    method: 'POST',
    body: { cwd },
  });
}

/** Asks the daemon on `machineId` to start a brand-new session with `text`. */
export async function createSession(machineId: string, text: string, cwd?: string): Promise<{ sessionId: string }> {
  const data = await api<{ sessionId?: string }>(`/machines/${encodeURIComponent(machineId)}/sessions`, {
    method: 'POST',
    body: { text, ...(cwd ? { cwd } : {}) },
  });
  if (!data.sessionId) throw new Error('服务器未返回会话 ID');
  return { sessionId: data.sessionId };
}

export async function abortSession(machineId: string, sessionId: string): Promise<void> {
  await api(`/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/abort`, {
    method: 'POST',
    body: {},
  });
}
