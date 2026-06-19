export type HookKind = 'event' | 'pipeline' | 'guard';

export type GuardHookResult<TEvent = unknown> =
  | void
  | { action: 'continue'; event?: TEvent }
  | { action: 'handled'; reason?: string }
  | { action: 'block'; reason?: string };

export type HookHandler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  ctx: HookExecutionContext,
) => void | TResult | Promise<void | TResult>;

export type HookExecutionContext = {
  hook: string;
  pluginId?: string;
};

export type HookOptions = {
  pluginId?: string;
  priority?: number;
  failPolicy?: 'continue' | 'stop' | 'block';
};
