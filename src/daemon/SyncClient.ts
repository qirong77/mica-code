import type { PersistedSession } from '@packages/mica-session/index.js';

export type DaemonCommand =
  | { type: 'run'; id: string; sessionId: string; prompt: string; requestedAt: string }
  | { type: 'create'; id: string; sessionId: string; prompt: string; cwd?: string; requestedAt: string }
  | { type: 'update_cwd'; id: string; sessionId: string; cwd: string; requestedAt: string }
  | { type: 'abort'; id: string; sessionId: string; requestedAt: string };

export type DaemonActive = { sessionId: string | null; running: boolean };

const POLL_TIMEOUT_MS = 35_000;

/** HTTP client for the mica-sync central server. */
export class SyncClient {
  private machineId: string | null = null;

  constructor(private readonly serverUrl: string) {}

  setMachineId(machineId: string): void {
    this.machineId = machineId;
  }

  /** Register (or refresh the identity of) this machine; the server reuses
   *  the record for the same hostname so a lost sync.json keeps its id. */
  async register(
    name: string,
    hostname: string,
    platform: string,
    version: string,
  ): Promise<{ machineId: string; name: string }> {
    const response = await this.request('/daemon/register', {
      method: 'POST',
      body: { name, hostname, platform, version },
    });
    return {
      machineId: String(response.machineId ?? ''),
      name: String(response.name ?? name),
    };
  }

  async beat(active: DaemonActive): Promise<void> {
    await this.request('/daemon/beat', { method: 'POST', body: { active } });
  }

  /** Long-poll for commands; the server holds the request until a command arrives. */
  async poll(): Promise<DaemonCommand[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const response = await this.request('/daemon/poll', {
        method: 'POST',
        body: {},
        signal: controller.signal,
      });
      return Array.isArray(response.commands) ? (response.commands as DaemonCommand[]) : [];
    } finally {
      clearTimeout(timer);
    }
  }

  async pushSession(session: PersistedSession): Promise<void> {
    await this.request('/daemon/session', { method: 'POST', body: { session } });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('/daemon/session', { method: 'POST', body: { session: null, sessionId } });
  }

  async pushEvents(
    sessionId: string,
    events: Array<Record<string, unknown>>,
    session?: PersistedSession,
  ): Promise<void> {
    await this.request('/daemon/events', {
      method: 'POST',
      body: { sessionId, events, ...(session ? { session } : {}) },
    });
  }

  private async request(
    path: string,
    options: { method: string; body?: unknown; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.machineId) headers['x-machine-id'] = this.machineId;

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new Error(
        aborted ? 'Request timed out' : `Network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let data: Record<string, unknown> = {};
    try {
      const text = await response.text();
      if (text) data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${JSON.stringify(data)?.slice(0, 300) ?? response.statusText}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return data;
  }
}
