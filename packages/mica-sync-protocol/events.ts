/** Event as stored/replayed over SSE (sequence number and timestamp added by the server). */
export type SyncEvent = {
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
};

/** Input to the server event hub; the server stamps `seq` and `ts`. */
export type NewSyncEvent = {
  type: string;
  [key: string]: unknown;
};

/** Turn events pushed by the daemon. Payload fields stay open so the protocol can grow without a full version bump. */
export type DaemonEvent =
  | { type: 'user_input'; text: string; commandId?: string }
  | { type: 'thinking'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolId: string | null; name: string; args: unknown }
  | { type: 'tool_result'; toolId: string | null; name: string; output: unknown }
  | { type: 'usage'; usage: unknown }
  | { type: 'status'; status: unknown }
  | {
      type: 'turn';
      state: 'completed' | 'aborted' | 'error' | 'running';
      error?: string;
      commandId?: string;
    }
  | { type: 'queued'; prompt: string; position: number; queueMode: string }
  | { type: 'dequeue'; sessionId: string; prompt: string }
  | { type: 'queue_state'; queuedCount: number; queuedItems: unknown[] }
  | { type: 'run_rejected'; error: string }
  | { type: 'cwd_update'; ok: boolean; error?: string };
