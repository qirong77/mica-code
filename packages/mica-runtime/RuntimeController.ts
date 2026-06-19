import type { AbortResult } from './AbortResult.js';
import type { RuntimeEventBus } from './RuntimeEventBus.js';
import type { RuntimeStatus } from './RuntimeStatus.js';
import type { RuntimeViewSnapshot } from './RuntimeViewSnapshot.js';
import type { SubmitOptions, SubmitResult } from './SubmitResult.js';

export type RuntimeController = {
  readonly events: RuntimeEventBus;
  start(): Promise<void>;
  stop(): Promise<void>;
  submit(text: string, options?: SubmitOptions): Promise<SubmitResult>;
  abort(reason?: string): Promise<AbortResult>;
  getStatus(): RuntimeStatus;
  getSnapshot(): RuntimeViewSnapshot;
};
