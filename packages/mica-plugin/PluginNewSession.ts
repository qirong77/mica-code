/**
 * 「在一个新会话里跑这段提示词」——插件能请求的**唯一一种**跨出自己边界的动作。
 *
 * 插件经常需要「换一条干净上下文去做一件事」：复盘这一轮、给某个流程准备一次 agent 操作。
 * 自己起子会话要重建进程、绑角色、记账，重复一遍宿主已有的能力；所以插件只声明意图，
 * 建会话、绑角色、把页签摆到用户眼前、决定发不发都由宿主负责。
 *
 * 两个入口共用这一份形状：面板动作（`ctx.desktop.panel` 的回包）与配置页动作
 * （`ctx.actions` 的回包）。前者发生在对话里，后者发生在配置页——对插件来说都是「给人一段
 * 提示词」，不该出现两套字段。
 */

/** 提示词长度上限：它是给模型看的一整段，但插件不该用这条通道搬运整个文件。 */
export const MAX_NEW_SESSION_PROMPT = 20_000;

export type PluginNewSession = {
  /** 新会话的第一条消息（`send: false` 时是先放进输入框的那段文本）。 */
  prompt: string;
  /** 新会话的角色；缺省沿用当前会话的角色。 */
  role?: string;
  /** 新会话的工作目录；缺省沿用当前会话的。 */
  cwd?: string;
  /**
   * 发送前是否先让用户看一眼提示词，默认 `true`。
   *
   * 开一个会话是有成本的动作（一次完整请求、一个新页签、侧栏多一条记录），默认让用户
   * 先确认；只有按钮本身已经表示「就是要开」时才关掉它。`send: false` 时这一项无意义
   * ——输入框里的话本来就要用户自己按回车。
   */
  confirm?: boolean;
  /**
   * 是否把它作为新会话的第一条消息**发出去**，默认 `true`。
   *
   * 写 `false` 就是「开一个会话、把提示词放进输入框、聚焦」，用户还能改、能删，按回车才
   * 算数。适合那种「怎么做由人决定、agent 只是执行」的场合：按钮不该替用户按下发送。
   */
  send?: boolean;
};

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 归一化：没有提示词就什么都不做（返回 undefined），其余字段能认的才带上。
 *
 * `confirm` / `send` 只在显式 `false` 时生效——认不出的一律按默认（确认 + 发送）处理，
 * 那是更保守的一侧。
 */
export function normalizePluginNewSession(value: unknown): PluginNewSession | undefined {
  const raw = record(value);
  const prompt = text(raw.prompt, MAX_NEW_SESSION_PROMPT);
  if (!prompt) return undefined;
  const role = text(raw.role, 40);
  const cwd = text(raw.cwd, 1000);
  return {
    prompt,
    ...(role ? { role } : {}),
    ...(cwd ? { cwd } : {}),
    ...(raw.confirm === false ? { confirm: false } : {}),
    ...(raw.send === false ? { send: false } : {}),
  };
}
