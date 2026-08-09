// Wire contract shared by the mica-sync daemon (apps/cli/src/features/sync-daemon),
// the central server (apps/sync/server) and the web console (apps/sync/web).

export type { DaemonActive, DaemonCommand } from './commands.js';
export type { DaemonEvent, NewSyncEvent, SyncEvent } from './events.js';
export type {
  CreateSessionRequest,
  CreateSessionResponse,
  LastUsage,
  MachineInfo,
  RunSessionRequest,
  SessionSummary,
  StoredSession,
  UpdateCwdRequest,
} from './api.js';
