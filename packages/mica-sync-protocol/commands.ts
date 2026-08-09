/** Commands dispatched from the sync server to a machine's `mica daemon` via long-polling. */
export type DaemonCommand =
  | { type: 'run'; id: string; sessionId: string; prompt: string; requestedAt: string }
  | { type: 'create'; id: string; sessionId: string; prompt: string; cwd?: string; requestedAt: string }
  | { type: 'update_cwd'; id: string; sessionId: string; cwd: string; requestedAt: string }
  | { type: 'abort'; id: string; sessionId: string; requestedAt: string };

/** Active-turn state reported by the daemon in heartbeats. */
export type DaemonActive = { sessionId: string | null; running: boolean };
