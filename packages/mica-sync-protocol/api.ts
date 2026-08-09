/** Wire shape of a machine as returned by the web-facing API (`online` is computed server-side). */
export type MachineInfo = {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  version: string;
  createdAt: string;
  lastSeen: string;
  activeSessionId: string | null;
  activeRunning: boolean;
  online: boolean;
};

/** Lightweight session summary used in lists and live `session` SSE events. */
export type SessionSummary = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  providerId: string;
  model: string;
  effort?: string;
  role?: string;
  turnState: string;
  uncompleted: boolean;
  /** SSE watermark of the latest published session snapshot; the web client opens SSE from here on switch. */
  snapshotSeq?: number;
};

export type LastUsage = {
  provider?: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** Session detail returned to the web console. Provider `messages`/`usageHistory` are stripped by default. */
export type StoredSession = {
  id: string;
  revision?: number;
  title: string;
  titleSource?: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  turnState: string;
  snapshot: {
    providerId?: string;
    model?: string;
    effort?: string;
    role?: string;
    contextWindowSize?: number;
    conversationMessages?: unknown[];
    usageHistory?: unknown[];
    lastUsage?: LastUsage;
  };
};

export type CreateSessionRequest = { text: string; cwd?: string };
export type CreateSessionResponse = { sessionId: string; commandId: string };
export type RunSessionRequest = { text: string };
export type UpdateCwdRequest = { cwd: string };
