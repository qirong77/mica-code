import type { RuntimeInput } from './RuntimeInput.js';

export type RuntimeEvent =
  | { type: 'queue:changed'; pendingInputs: RuntimeInput[]; owner?: unknown }
  | { type: 'session:cleared'; owner?: unknown }
  /** Session history changed outside a model turn; owner-scoped plugin state should reset. */
  | { type: 'session:invalidated'; reason: 'resume' | 'rewind'; owner?: unknown }
  | { type: 'session:disposed'; owner: unknown }
  /**
   * 用户在输入框里敲了字。不是一次提交，只是「这个人回来了」的信号——会话空闲很久之后
   * 的第一下按键，说明下一轮请求很快就要发出，插件可以趁这个间隙先做准备（自动压缩在
   * 这里把历史压小）。
   *
   * 只有能在输入框旁边实时观察到敲字的宿主才会发（桌面的常驻会话宿主）；TUI 与
   * `mica exec` 不发，插件不能把它当成一定会来的事件。
   */
  | { type: 'input:activity'; owner?: unknown }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string; owner?: unknown; ttl?: number }
  | { type: 'turn:started'; input: RuntimeInput; owner?: unknown; preservePreviousTurnUi?: boolean }
  | { type: 'turn:finished'; input: RuntimeInput; elapsedMs: number; owner?: unknown }
  | { type: 'turn:error'; input: RuntimeInput; error: unknown; owner?: unknown }
  | { type: 'turn:aborted'; input: RuntimeInput; owner?: unknown };

export type RuntimeEventMap = {
  event: RuntimeEvent;
};
