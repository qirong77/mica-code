import type { RuntimeInput } from './RuntimeInput.js';

export type RuntimeEvent =
  | { type: 'queue:changed'; pendingInputs: RuntimeInput[]; owner?: unknown }
  | { type: 'session:cleared'; owner?: unknown }
  /** Session history changed outside a model turn; owner-scoped plugin state should reset. */
  | { type: 'session:invalidated'; reason: 'resume' | 'rewind'; owner?: unknown }
  | { type: 'session:disposed'; owner: unknown }
  /**
   * 用户在输入框里敲了字。不是一次提交，只是「这个人回来了」的信号——会话空闲很久之后
   * 的第一下按键，说明下一轮请求很快就要发出，插件可以趁这个间隙先做准备（例如压缩插件
   * 在这里把历史压小）。
   *
   * 只有能在输入框旁边实时观察到敲字的宿主才会发（桌面的常驻会话宿主）；TUI 与
   * `mica exec` 不发，插件不能把它当成一定会来的事件。
   */
  | { type: 'input:activity'; owner?: unknown }
  /**
   * 用户把焦点放回了输入框（点进来 / 快捷键聚焦），但还没敲字。
   *
   * 与 `input:activity` 的区别是「不依赖已经开始输入」：要趁下一轮请求发出之前压缩历史
   * 的策略（例如压缩插件）靠它提前一步动手，不必等第一个按键。同样只有能观察输入框的宿主
   * 才发，插件不能当成一定会来。
   */
  | { type: 'input:focus'; owner?: unknown }
  /**
   * 用户推翻了刚才的输入或回答：就地改写重跑、撤回还没发出去的排队消息、原样重发。
   *
   * 这是「这次回答没被接受」唯一确凿的信号——比模型自评可靠得多，自进化按它挑样本
   * 才不会挑到「模型以为自己做对了」的那些。只有能观察到输入框的宿主才发。
   */
  | { type: 'input:corrected'; kind: 'edit' | 'recall' | 'retry'; chars?: number; owner?: unknown }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string; owner?: unknown; ttl?: number }
  | { type: 'turn:started'; input: RuntimeInput; owner?: unknown; preservePreviousTurnUi?: boolean }
  | { type: 'turn:finished'; input: RuntimeInput; elapsedMs: number; owner?: unknown }
  | { type: 'turn:error'; input: RuntimeInput; error: unknown; owner?: unknown }
  | { type: 'turn:aborted'; input: RuntimeInput; owner?: unknown };

export type RuntimeEventMap = {
  event: RuntimeEvent;
};
