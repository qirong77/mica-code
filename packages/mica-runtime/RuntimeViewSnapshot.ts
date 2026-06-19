import type { RuntimeInput } from './RuntimeInput.js';
import type { RuntimeStatus } from './RuntimeStatus.js';

export type RuntimeViewSnapshot = {
  status: RuntimeStatus;
  pendingInputs: RuntimeInput[];
};
