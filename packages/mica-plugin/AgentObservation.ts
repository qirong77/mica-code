/**
 * Read-only snapshots emitted through `agent:observe` by AgentRuntime.
 * `owner` is the runtime identity; consumers must not mutate it. No text or
 * thinking deltas are included. Request events fire before each model request,
 * including the first and failed requests, and exclude transport retry attempts.
 */
export type AgentObservationEvent = Readonly<{
  owner: object;
  runId: number;
  timestamp: string;
}> & (
  | Readonly<{
      type: 'run:start';
      input: unknown;
      config: Readonly<{ providerId: string; protocol: string; model: string; effort: string; role: string }>;
    }>
  | Readonly<{
      type: 'request:start';
      messageCount: number;
      /** Snapshot of the exact tool definitions sent by the provider; absent when tools are disabled. */
      tools?: unknown;
    }>
  | Readonly<{ type: 'prompt:resolved'; prompt: string }>
  | Readonly<{ type: 'history:rewritten'; beforeCount: number; afterCount: number }>
  | Readonly<{ type: 'tool:call'; name: string; args: string; id?: string }>
  | Readonly<{ type: 'tool:result'; name: string; result: string; id?: string }>
  | Readonly<{
      type: 'usage';
      usage: Readonly<{
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        totalTokens?: number;
        model?: string;
      }>;
    }>
  | Readonly<{ type: 'retry'; attempt: number; delayMs: number; error: string }>
  | Readonly<{
      type: 'run:finish';
      outcome: 'completed' | 'aborted' | 'error';
      elapsedMs: number;
      error?: string;
    }>
);
