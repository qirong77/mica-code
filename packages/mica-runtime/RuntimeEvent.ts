import type { RuntimeInput } from './RuntimeInput.js';

export type RuntimeEvent =
  | { type: 'queue:changed'; pendingInputs: RuntimeInput[]; owner?: unknown }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string; owner?: unknown; ttl?: number }
  | { type: 'turn:started'; input: RuntimeInput; owner?: unknown; preservePreviousTurnUi?: boolean }
  | { type: 'turn:finished'; input: RuntimeInput; elapsedMs: number; owner?: unknown }
  | { type: 'turn:error'; input: RuntimeInput; error: unknown; owner?: unknown }
  | { type: 'turn:aborted'; input: RuntimeInput; owner?: unknown };

export type RuntimeEventMap = {
  event: RuntimeEvent;
};
