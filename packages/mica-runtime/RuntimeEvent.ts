import type { RuntimeInput } from './RuntimeInput.js';

export type RuntimeEvent =
  | { type: 'queue:changed'; pendingInputs: RuntimeInput[]; owner?: unknown }
  | { type: 'session:cleared'; owner?: unknown }
  /** Session history changed outside a model turn; owner-scoped plugin state should reset. */
  | { type: 'session:invalidated'; reason: 'resume' | 'rewind'; owner?: unknown }
  | { type: 'session:disposed'; owner: unknown }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string; owner?: unknown; ttl?: number }
  | { type: 'turn:started'; input: RuntimeInput; owner?: unknown; preservePreviousTurnUi?: boolean }
  | { type: 'turn:finished'; input: RuntimeInput; elapsedMs: number; owner?: unknown }
  | { type: 'turn:error'; input: RuntimeInput; error: unknown; owner?: unknown }
  | { type: 'turn:aborted'; input: RuntimeInput; owner?: unknown }
  /** Context usage snapshot published whenever a turn reports usage (TUI + headless). */
  | { type: 'context:changed'; tokens: number; windowSize: number; owner?: unknown };

export type RuntimeEventMap = {
  event: RuntimeEvent;
};
