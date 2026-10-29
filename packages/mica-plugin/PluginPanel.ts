import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件在桌面端对话右侧的**面板**（视图数据 + 动作回传）。
 *
 * 页面是构建期打的包，只有随包插件的 `desktop.jsx` 会被收录；用户装在
 * `$MICA_HOME/plugins` 的插件没有前端模块，也永远不会有。所以插件要在页面上放东西，
 * 只有一条通用路径：**插件给数据，宿主画出来**。
 *
 * 这份类型就是那份数据的形状——足够表达「读几行状态 + 几个输入框 + 几个按钮 + 一列可
 * 逐项操作的条目」，又是纯数据，能直接跨进程（app-server → 运行时 → 页面）传输。
 * 每个 section 在页面上是一块独立的可折叠卡片，插件用 `collapsed` 决定它初始是否收起。
 * 宿主不认识任何具体插件，插件也不认识 React。
 *
 * 约定：
 * - 动作只回 `{ action, key?, values? }`，插件按 id 自己分派；
 * - 每次动作之后宿主重新取一次视图，所以插件不需要回传「新视图」；
 * - 视图里所有文本都由宿主裁剪长度，插件不必考虑超长字符串。
 */

export type PluginPanelTone = 'muted' | 'ok' | 'warn' | 'error' | 'accent';

export type PluginPanelButtonTone = 'primary' | 'ghost' | 'danger';

/** 只读的一行「标签 — 值」（上次检查时间、上次结论、运行状态…）。 */
export type PluginPanelRow = {
  label: string;
  value?: string;
  tone?: PluginPanelTone;
};

/** 条目上的按钮：`key` 由宿主带上，插件据此知道点的是哪一条。 */
export type PluginPanelItemAction = {
  id: string;
  label: string;
  tone?: PluginPanelButtonTone;
  disabled?: boolean;
};

/** 一列条目（频道清单、连接清单…），每条可带自己的按钮。 */
export type PluginPanelItem = {
  key: string;
  label: string;
  value?: string;
  tone?: PluginPanelTone;
  actions?: PluginPanelItemAction[];
};

/** 输入框：值随同一次动作一起回传，插件负责把它落到自己的状态里。 */
export type PluginPanelField = {
  key: string;
  label: string;
  type?: 'text' | 'number';
  value?: string;
  placeholder?: string;
  hint?: string;
};

export type PluginPanelAction = PluginPanelItemAction & { hint?: string };

export type PluginPanelSection = {
  title?: string;
  /**
   * 默认收起。宿主把每个 section 画成一块可折叠的卡片（点标题展开/收起），
   * 这里只决定它**第一次**出现时是展开还是收起；之后跟随用户的操作。
   */
  collapsed?: boolean;
  /** 只读行；与 `fields` / `actions` 一起用时排在它们上面。 */
  rows?: PluginPanelRow[];
  /** 条目列表；为空时显示 `empty`。 */
  items?: PluginPanelItem[];
  empty?: string;
  /** 输入框；当前值由插件给，动作之后重新取视图。 */
  fields?: PluginPanelField[];
  /**
   * 字段改完自动生效：声明后宿主在输入停顿约 0.5s 时用这个动作提交整块字段值，
   * 不需要用户再点按钮。设置类 section 用它，动作类 section 留空。
   */
  commit?: string;
  /** 按钮，成组渲染在 section 底部。 */
  actions?: PluginPanelAction[];
};

export type PluginPanelView = {
  title: string;
  subtitle?: string;
  /** 标题右侧那一段状态（「轮询中」「已停止」）。 */
  status?: { label: string; tone?: PluginPanelTone };
  sections?: PluginPanelSection[];
};

export type PluginPanelActionInput = {
  /** 被点的按钮 id（`PluginPanelAction.id` / `PluginPanelItemAction.id`）。 */
  action: string;
  /** 条目动作所属的条目 key（`PluginPanelItem.key`）。 */
  key?: string;
  /** 同一次动作里，面板上所有输入框的值。 */
  values?: Record<string, string>;
};

/**
 * 动作可以回一句给用户的话。
 *
 * 说「这个动作做不了，因为…」时用它：`ctx.ui.notice()` 在常驻宿主里只落进 notice
 * 记录，用户点完按钮往往看不到任何反应；把原因放这里，页面会紧挨着按钮显示一次。
 */
/**
 * 在**另一个会话**里跑一段提示词。
 *
 * 面板里点一个按钮就开一个会话（例如「复盘」不该污染当前这轮对话）有两种做法：插件自己
 * 起一个子会话进程，或者把「要跑什么」交给宿主。后者才是通用能力——建会话、绑角色、
 * 起进程、把新页签摆到用户眼前都是宿主的事，插件只声明意图。
 */
export type PluginPanelNewSession = {
  /** 新会话的第一条消息。 */
  prompt: string;
  /** 新会话的角色；缺省沿用当前会话的角色。 */
  role?: string;
  /** 新会话的工作目录；缺省沿用当前会话的。 */
  cwd?: string;
  /**
   * 发送前是否先让用户看一眼提示词，默认 `true`。
   *
   * 开一个会话是有成本的动作（一次完整请求、一个新页签、侧栏多一条记录），默认让用户
   * 先确认；只有按钮本身已经表示「就是要开」时才关掉它。
   */
  confirm?: boolean;
};

/**
 * 动作的回包：一句话 + 两种「跨出面板一步」的效果。
 *
 * - `compose` —— 把这段文本放进当前会话的输入框，**不发送**。用户还能改、能删，按回车才
 *   算数。需要模型「先看一眼再决定发不发」的时候用它，比直接投递更可控。
 * - `newSession` —— 新开一个会话，把这段提示词作为它的第一条消息发出去。
 */
export type PluginPanelActionResult = {
  message?: string;
  compose?: string;
  newSession?: PluginPanelNewSession;
};

export type PluginPanelViewInput = {
  /** 当前会话的角色名（`$MICA_HOME/role/<name>.md`；内置默认是 `default`）。 */
  role: string;
};

/**
 * 插件注册的面板处理器。
 *
 * `view` 会被反复调用（打开面板、每次动作之后、页面轮询时），所以它必须**廉价**：
 * 只读自己缓存的状态，不要在这里跑外部命令或请求模型——那些属于动作或插件的定时器。
 */
export type PluginPanelHandler = {
  view(input: PluginPanelViewInput): PluginPanelView | Promise<PluginPanelView>;
  action(
    input: PluginPanelActionInput,
  ): void | PluginPanelActionResult | Promise<void | PluginPanelActionResult>;
};

export type PluginPanelRegistration = Disposable & {
  pluginId: string;
};

/**
 * 进程内的面板登记表。
 *
 * 一个插件最多一块面板（`ctx.desktop.panel()` 再调用会替换上一块），因为「对话右侧」
 * 只有一条位置：多块面板就变成插件之间的版面竞争，而那需要插件排序、折叠、互斥等一整套
 * 规则——真需要时再设计，现在不假装支持。
 */
export class PluginPanelRegistry {
  private readonly handlers = new Map<string, PluginPanelHandler>();

  add(pluginId: string, handler: PluginPanelHandler): PluginPanelRegistration {
    this.handlers.set(pluginId, handler);
    return {
      pluginId,
      dispose: () => {
        if (this.handlers.get(pluginId) === handler) this.handlers.delete(pluginId);
      },
    };
  }

  get(pluginId: string): PluginPanelHandler | null {
    return this.handlers.get(pluginId) ?? null;
  }

  ids(): string[] {
    return [...this.handlers.keys()];
  }
}

/* -------------------------------------------------------------- 视图归一化 */

const MAX_TEXT = 400;
const MAX_ROWS = 40;
const MAX_ITEMS = 40;
const MAX_FIELDS = 12;
const MAX_ACTIONS = 8;
const MAX_SECTIONS = 8;
/** 提示词整段回传的上限：它是一段给模型看的正文，不是一行状态。 */
const MAX_PROMPT = 20_000;

const TONES: readonly PluginPanelTone[] = ['muted', 'ok', 'warn', 'error', 'accent'];
const BUTTON_TONES: readonly PluginPanelButtonTone[] = ['primary', 'ghost', 'danger'];

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function tone(value: unknown): PluginPanelTone | undefined {
  return TONES.includes(value as PluginPanelTone) ? (value as PluginPanelTone) : undefined;
}

function buttonTone(value: unknown): PluginPanelButtonTone | undefined {
  return BUTTON_TONES.includes(value as PluginPanelButtonTone)
    ? (value as PluginPanelButtonTone)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionOf(input: unknown): PluginPanelAction | null {
  const raw = record(input);
  const id = text(raw.id, 64);
  const label = text(raw.label, 32);
  if (!id || !label) return null;
  const hint = text(raw.hint, 200);
  return {
    id,
    label,
    ...(buttonTone(raw.tone) ? { tone: buttonTone(raw.tone) } : {}),
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(hint ? { hint } : {}),
  };
}

function itemOf(input: unknown): PluginPanelItem | null {
  const raw = record(input);
  const key = text(raw.key, 200);
  const label = text(raw.label, 120);
  if (!key || !label) return null;
  const value = text(raw.value, 200);
  const actions = list(raw.actions)
    .slice(0, MAX_ACTIONS)
    .map((entry) => actionOf(entry))
    .filter((entry): entry is PluginPanelAction => entry !== null)
    .map(({ id, label: actionLabel, tone: actionTone, disabled }) => ({
      id,
      label: actionLabel,
      ...(actionTone ? { tone: actionTone } : {}),
      ...(disabled ? { disabled } : {}),
    }));
  return {
    key,
    label,
    ...(value ? { value } : {}),
    ...(tone(raw.tone) ? { tone: tone(raw.tone) } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

function fieldOf(input: unknown): PluginPanelField | null {
  const raw = record(input);
  const key = text(raw.key, 64);
  const label = text(raw.label, 40);
  if (!key || !label) return null;
  const hint = text(raw.hint, 200);
  const placeholder = text(raw.placeholder, 120);
  return {
    key,
    label,
    type: raw.type === 'number' ? 'number' : 'text',
    ...(raw.value === undefined || raw.value === null ? {} : { value: text(String(raw.value), 200) }),
    ...(placeholder ? { placeholder } : {}),
    ...(hint ? { hint } : {}),
  };
}

function sectionOf(input: unknown): PluginPanelSection | null {
  const raw = record(input);
  const title = text(raw.title, 60);
  const rows = list(raw.rows)
    .slice(0, MAX_ROWS)
    .map((entry) => {
      const row = record(entry);
      const label = text(row.label, 60);
      if (!label) return null;
      const value = text(row.value, 240);
      const rowTone = tone(row.tone);
      return {
        label,
        ...(value ? { value } : {}),
        ...(rowTone ? { tone: rowTone } : {}),
      } satisfies PluginPanelRow;
    })
    .filter((entry): entry is PluginPanelRow => entry !== null);
  const items = list(raw.items)
    .slice(0, MAX_ITEMS)
    .map((entry) => itemOf(entry))
    .filter((entry): entry is PluginPanelItem => entry !== null);
  const fields = list(raw.fields)
    .slice(0, MAX_FIELDS)
    .map((entry) => fieldOf(entry))
    .filter((entry): entry is PluginPanelField => entry !== null);
  const actions = list(raw.actions)
    .slice(0, MAX_ACTIONS)
    .map((entry) => actionOf(entry))
    .filter((entry): entry is PluginPanelAction => entry !== null);
  const empty = text(raw.empty, 200);
  // 只有真有输入框时，自动提交才有意义
  const commit = fields.length > 0 ? text(raw.commit, 60) : '';
  if (!title && rows.length === 0 && items.length === 0 && fields.length === 0 && actions.length === 0)
    return null;
  return {
    ...(title ? { title } : {}),
    ...(title && raw.collapsed === true ? { collapsed: true } : {}),
    ...(rows.length > 0 ? { rows } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(empty ? { empty } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(commit ? { commit } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/**
 * 把插件给的视图裁剪成页面能安全渲染的形状。
 *
 * 插件是自己写的代码，返回畸形视图不该让整块面板（乃至页面）崩掉：认不出的字段丢掉、
 * 超长文本截断、条目与动作有上限。缺失的 `title` 退回插件名——面板总得有个标题。
 */
export function normalizePluginPanelView(input: unknown, fallbackTitle = '插件'): PluginPanelView {
  const raw = record(input);
  const title = text(raw.title, 60) || fallbackTitle;
  const subtitle = text(raw.subtitle, 200);
  const statusRaw = record(raw.status);
  const statusLabel = text(statusRaw.label, 40);
  const sections = list(raw.sections)
    .slice(0, MAX_SECTIONS)
    .map((entry) => sectionOf(entry))
    .filter((entry): entry is PluginPanelSection => entry !== null);
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(statusLabel
      ? { status: { label: statusLabel, ...(tone(statusRaw.tone) ? { tone: tone(statusRaw.tone) } : {}) } }
      : {}),
    ...(sections.length > 0 ? { sections } : {}),
  };
}

/** 动作入参的归一化：插件拿到的一定是干净的 `{ action, key?, values? }`。 */
export function normalizePluginPanelAction(input: unknown): PluginPanelActionInput | null {
  const raw = record(input);
  const action = text(raw.action, 64);
  if (!action) return null;
  const key = text(raw.key, 200);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(raw.values))) {
    if (typeof value === 'string') values[name] = text(value, 2000);
  }
  return {
    action,
    ...(key ? { key } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
}

/**
 * 动作回包的归一化：一句非空文本 + 两种可选效果，其余一律当作「没说话」。
 *
 * 提示词的长度上限比普通文案大得多（它是给模型看的一整段），但仍然有上限：插件不该用
 * 这条通道搬运整个文件，那是 `compose` 之外的事。
 */
export function normalizePluginPanelActionResult(input: unknown): PluginPanelActionResult {
  const raw = record(input);
  const message = text(raw.message, 120);
  const compose = text(raw.compose, MAX_PROMPT);
  const newSession = newSessionOf(raw.newSession);
  return {
    ...(message ? { message } : {}),
    ...(compose ? { compose } : {}),
    ...(newSession ? { newSession } : {}),
  };
}

function newSessionOf(value: unknown): PluginPanelNewSession | undefined {
  const raw = record(value);
  const prompt = text(raw.prompt, MAX_PROMPT);
  if (!prompt) return undefined;
  const role = text(raw.role, 40);
  const cwd = text(raw.cwd, 1000);
  return {
    prompt,
    ...(role ? { role } : {}),
    ...(cwd ? { cwd } : {}),
    // 只有显式 `false` 才跳过确认：认不出的一律按「要确认」处理，那才是安全的一侧。
    ...(raw.confirm === false ? { confirm: false } : {}),
  };
}
