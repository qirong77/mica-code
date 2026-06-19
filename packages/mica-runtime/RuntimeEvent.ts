import type { RuntimeInput } from './RuntimeInput.js';

export type RuntimeEvent =
  | { type: 'queue:changed'; pendingInputs: RuntimeInput[]; owner?: unknown }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string; owner?: unknown; ttl?: number }
  | { type: 'turn:started'; input: RuntimeInput }
  | { type: 'turn:finished'; input: RuntimeInput; elapsedMs: number }
  | { type: 'turn:error'; input: RuntimeInput; error: unknown }
  | { type: 'turn:aborted'; input: RuntimeInput };

export type RuntimeEventMap = {
  event: RuntimeEvent;
};
