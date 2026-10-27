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

/** `turn:before`：用户输入已落进会话，模型请求还没发出。 */
export type RuntimeTurnBeforeHookEvent = {
  /** 触发这一轮的宿主（交互式 runtime 或 headless host）。 */
  runtime: unknown;
  input: RuntimeInput;
  /** 已解析的多模态内容；未解析时为 undefined。 */
  content?: unknown;
};

export type RuntimeTurnAfterHookEvent = {
  input: RuntimeInput;
  elapsedMs: number;
  hasError: boolean;
  outcome: TurnOutcome;
  owner: RuntimeOwner;
};

export type TurnOutcome = 'completed' | 'aborted' | 'error';
