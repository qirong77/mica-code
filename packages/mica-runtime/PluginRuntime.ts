import type { RuntimeInput } from './RuntimeInput.js';

/** Opaque identity used to keep plugin operations scoped to the agent that produced an event. */
export type RuntimeOwner = object;

export type RuntimePluginQueue = {
  isBusy(owner: RuntimeOwner): boolean;
  enqueue(owner: RuntimeOwner, input: RuntimeInput): boolean;
  dequeue(owner: RuntimeOwner): RuntimeInput | null;
  list(owner: RuntimeOwner): RuntimeInput[];
};

export type RuntimeInputReceivedHookEvent = {
  input: RuntimeInput;
  isCommand: boolean;
  owner: RuntimeOwner;
};

export type RuntimeTurnAfterHookEvent = {
  input: RuntimeInput;
  elapsedMs: number;
  hasError: boolean;
  owner: RuntimeOwner;
};
