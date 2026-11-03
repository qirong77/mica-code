import type { Disposable } from '@packages/mica-common/index.js';
import { normalizePluginNewSession, type PluginNewSession } from './PluginNewSession.js';
import { isValidPluginPanelShortcutId } from './PluginDesktop.js';

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

export type PluginPanelButtonTone = 'primary' | 'default' | 'ghost' | 'danger';

/** 只读的一行「标签 — 值」（上次检查时间、上次结论、运行状态…）。 */
export type PluginPanelRow = {
  label: string;
  value?: string;
  tone?: PluginPanelTone;
  /**
   * 值是一段话或一个长路径：换行显示，不再单行省略。
   *
   * 行默认单行省略（一列状态看起来才齐），但「一句话讲清这次需求」「副本路径」这类
   * 内容被省略就等于没写——需要读完整时声明它。
   */
  wrap?: boolean;
  /**
   * 值本身是一个地址：点了交给系统浏览器打开（页面自己跳转会把应用导航走）。
   *
   * 宿主只认 `http(s)` / `mailto`，其余当普通文本；`value` 仍是显示出来的那段文字。
   */
  link?: string;
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
  /**
   * 输入框类型。
   *
   * `password` 是密文输入（带眼睛按钮切明文）：口令、Token 这类值不该以明文出现在
   * 面板上——它会被截图、被旁人看到，也不该因为「面板只有 text / number 两种」就让
   * 插件自己发明一个 `type: 'secret'` 的私有约定。
   */
  type?: PluginPanelFieldType;
  value?: string;
  placeholder?: string;
  hint?: string;
};

/** `PluginPanelField.type` 的取值（单一事实来源，归一化与界面共用）。 */
export const PLUGIN_PANEL_FIELD_TYPES = ['text', 'number', 'password'] as const;

export type PluginPanelFieldType = (typeof PLUGIN_PANEL_FIELD_TYPES)[number];

export function isPluginPanelFieldType(value: unknown): value is PluginPanelFieldType {
  return typeof value === 'string' && (PLUGIN_PANEL_FIELD_TYPES as readonly string[]).includes(value);
}

export type PluginPanelAction = PluginPanelItemAction & { hint?: string };

export type PluginPanelSection = {
  title?: string;
  /**
   * 标题下面的一行说明（「评审只读提交」这类）。弹窗形态里在分区标题下方，抽屉形态里
   * 是折叠卡片标题右侧的 meta。它不占正文，所以没有条目的空态照常画。
   */
  subtitle?: string;
  /**
   * 一块正文：会换行、保留段落（需求描述、结论这类「一段话」）。
   *
   * 与 `rows` 的分工：行是「标签 — 一个值」，正文字段没有标签、也不该被单行省略。
   * 排在 `rows` 之上。
   */
  text?: string;
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
  /**
   * 给快捷按钮用的悬浮菜单内容，按 key 取（`desktop.panel.shortcuts[].menu` 指向这里）。
   *
   * 菜单条目往往是**运行期才确定**的：这次的开发副本、这台机器上已配置的通道、当前打开
   * 的工作区。清单是磁盘上的静态文件，写不出这些；所以清单只声明「这个按钮是个菜单、
   * 取哪一块」，具体条目由插件在视图里给。宿主因此可以在按钮上悬停时取一次视图。
   */
  menus?: Record<string, PluginPanelMenuItem[]>;
  /** 按清单中快捷按钮的 id 提供当前状态。 */
  shortcutStates?: Record<string, PluginPanelShortcutState>;
};

export type PluginPanelShortcutState = {
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
};

/**
 * 一个菜单条目：点了交给插件的哪个动作、带哪个 key。
 *
 * `detail` 是条目右侧的一行补充（基线分支、会话状态），纯展示，不参与匹配。
 */
export type PluginPanelMenuItem = {
  label: string;
  detail?: string;
  action: string;
  key?: string;
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
 * 动作的回包：一句话 + 两种「跨出面板一步」的效果。
 *
 * - `compose` —— 把这段文本放进当前会话的输入框，**不发送**。用户还能改、能删，按回车才
 *   算数。需要模型「先看一眼再决定发不发」的时候用它，比直接投递更可控。
 * - `newSession` —— 新开一个会话，把这段提示词作为它的第一条消息发出去。
 * - `dialog` —— 弹一张只读表格（链接清单、对照表这类）。宿主管渲染，插件给数据。
 * - `openPath` —— 让宿主把这个文件在应用里打开（文件视图的编辑器就位）。面板只有 340px，
 *   超过一屏的正文（插件自己的配置、随包分发的 skill）在那里既看不清也改不动；编辑器是
 *   宿主已有的能力，插件只声明「打开哪个文件」。
 */
export type PluginPanelActionResult = {
  message?: string;
  compose?: string;
  /**
   * 在**另一个会话**里跑这段提示词（形状与配置页动作共用，见 `PluginNewSession`）。
   *
   * 面板里点一个按钮就开一个会话（例如「复盘」不该污染当前这轮对话）有两种做法：插件自己
   * 起一个子会话进程，或者把「要跑什么」交给宿主。后者才是通用能力——建会话、绑角色、
   * 起进程、把新页签摆到用户眼前都是宿主的事，插件只声明意图。
   */
  newSession?: PluginNewSession;
  dialog?: PluginPanelDialog;
  openPath?: PluginPanelOpenPath;
  openReview?: PluginPanelOpenReview;
};

/**
 * 让宿主在应用里打开一个文件。
 *
 * 路径是插件自己算出来的绝对路径（插件数据目录、随包资源落盘位置），宿主只负责打开，
 * 不猜它属于谁。`line` 用来落到某一行，编辑长文件时省一次滚动。
 *
 * `focus` 让宿主只画编辑器、把文件树与 Git 面板收起来：插件打开的是它自己的一份配置
 * 或规则，用户此刻要的是改这一份文件，不是逛工作区。不给就按普通打开（带侧栏）。
 */
export type PluginPanelOpenPath = {
  path: string;
  line?: number;
  focus?: boolean;
};

/**
 * 让宿主打开一次**分支评审**：`head` 相对 `base` 的改动，盖满整窗的评审视图，
 * 左边文件、右边 diff。
 *
 * 和 `openPath` 的分工：`openPath` 打开一个文件给人改，`openReview` 打开一段改动的审阅
 * 视图给人看。插件只知道「哪个仓库、哪条分支、比哪条基线」——怎么摆页签、缓存、渲染 diff
 * 是宿主的事，插件不碰。
 *
 * 宿主只读提交、不切工作区：评审别人的分支不会把评审人自己的未提交改动混进来，也不会
 * 改变当前会话的工作目录。`head` 缺省是那个目录当前检出的分支。
 */
export type PluginPanelOpenReview = {
  /** 要评审的仓库目录（通常是一份开发副本）。 */
  cwd: string;
  /** 对比基线；不给就按仓库自己的主分支解析（origin/HEAD → main → master）。 */
  base?: string;
  /** 要评审的分支；不给就取那个目录当前检出的分支。 */
  head?: string;
  /** 界面上显示的名字（`项目 · 分支`），缺省用目录名。 */
  label?: string;
};

/**
 * 弹窗表格里的一个格子。
 *
 * `link` 是给宿主的信号：这一格可以点，点了用系统浏览器打开（页面自己不做跳转）。插件
 * 不该把一段「点这里」的说明当链接传进来——宿主只认 `http(s)` / `mailto`，其余当普通文本。
 */
export type PluginPanelDialogCell = {
  text: string;
  link?: string;
  tone?: PluginPanelTone;
};

/**
 * 一张插件声明的只读表格弹窗。
 *
 * 为什么是表格而不是「更多行」：链接清单要的是对齐的列（类型 / 地址 / 备注），一行
 * 「标签 — 值」说不清哪一列是什么。插件仍然只给纯数据，宿主负责排版、省略超长链接、
 * 以及把 `link` 交给系统浏览器。
 */
export type PluginPanelDialog = {
  title: string;
  subtitle?: string;
  /**
   * 弹窗正文：一段会换行的纯文本（需求描述、结论这类不适合塞进格子的内容）。
   *
   * 表格的格子是单行省略的——给链接清单对得很齐，但放过一段话只会剩一行省略号。
   * 所以正文单独成一栏，表格可以没有：只有正文时它就是一个只读的文字弹窗。
   */
  text?: string;
  /** 列标题；行里的单元格按顺序对齐到这里。 */
  columns: string[];
  rows: PluginPanelDialogCell[][];
  /** 表格下面的一句说明（「还没填」时指向去哪里填）。 */
  note?: string;
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
/** 一块正文：需求描述这类「一段话」的上限，比一行的 400 字宽。 */
const MAX_SECTION_TEXT = 4000;
const MAX_ROWS = 40;
const MAX_ITEMS = 40;
const MAX_FIELDS = 12;
const MAX_ACTIONS = 8;
const MAX_SECTIONS = 12;
const MAX_DIALOG_COLUMNS = 6;
const MAX_DIALOG_ROWS = 50;
const MAX_DIALOG_TEXT = 4000;
const MAX_MENUS = 6;
const MAX_MENU_ITEMS = 20;
const MAX_MENU_DETAIL = 120;
const MAX_MENU_KEY = 200;
const MAX_ACTION_ID = 64;
const MAX_SHORTCUT_STATES = 40;
const MAX_SHORTCUT_BADGE = 12;
const MAX_SHORTCUT_DISABLED_REASON = 200;
/** 弹窗里的一格：链接地址可以很长（带查询串的分享链接），但仍然有上限。 */
const MAX_CELL_LINK = 2000;
/** 提示词整段回传的上限：它是一段给模型看的正文，不是一行状态。 */
const MAX_PROMPT = 20_000;
/** 打开文件只传路径，上限只是别让插件把整份正文塞进这条通道。 */
const MAX_PATH = 4096;

const TONES: readonly PluginPanelTone[] = ['muted', 'ok', 'warn', 'error', 'accent'];
const BUTTON_TONES: readonly PluginPanelButtonTone[] = ['primary', 'default', 'ghost', 'danger'];

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
    type: isPluginPanelFieldType(raw.type) ? raw.type : 'text',
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
      const link = text(row.link, MAX_CELL_LINK);
      const normalized: PluginPanelRow = {
        label,
        ...(value ? { value } : {}),
        ...(rowTone ? { tone: rowTone } : {}),
        ...(row.wrap === true ? { wrap: true } : {}),
        ...(link ? { link } : {}),
      };
      return normalized;
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
  const subtitle = text(raw.subtitle, 200);
  const empty = text(raw.empty, 200);
  const body = text(raw.text, MAX_SECTION_TEXT);
  // 只有真有输入框时，自动提交才有意义
  const commit = fields.length > 0 ? text(raw.commit, 60) : '';
  if (
    !title &&
    !body &&
    rows.length === 0 &&
    items.length === 0 &&
    fields.length === 0 &&
    actions.length === 0
  )
    return null;
  return {
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(body ? { text: body } : {}),
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
  const menus = menusOf(raw.menus);
  const shortcutStates = shortcutStatesOf(raw.shortcutStates);
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(statusLabel
      ? { status: { label: statusLabel, ...(tone(statusRaw.tone) ? { tone: tone(statusRaw.tone) } : {}) } }
      : {}),
    ...(sections.length > 0 ? { sections } : {}),
    ...(menus ? { menus } : {}),
    ...(shortcutStates ? { shortcutStates } : {}),
  };
}

function shortcutStatesOf(value: unknown): Record<string, PluginPanelShortcutState> | undefined {
  const states: Record<string, PluginPanelShortcutState> = {};
  let count = 0;
  for (const [id, input] of Object.entries(record(value))) {
    if (!isValidPluginPanelShortcutId(id) || !input || typeof input !== 'object' || Array.isArray(input)) continue;
    const raw = record(input);
    const badge = text(raw.badge, MAX_SHORTCUT_BADGE);
    const disabledReason = text(raw.disabledReason, MAX_SHORTCUT_DISABLED_REASON);
    const state: PluginPanelShortcutState = {
      ...(badge ? { badge } : {}),
      ...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
      ...(disabledReason ? { disabledReason } : {}),
    };
    if (Object.keys(state).length === 0) continue;
    Object.defineProperty(states, id, { value: state, enumerable: true, configurable: true, writable: true });
    if (++count >= MAX_SHORTCUT_STATES) break;
  }
  return count ? states : undefined;
}

/**
 * 快捷按钮的悬浮菜单：`{ [menuKey]: 条目[] }`。
 *
 * 没有 `action` 的条目点了什么也不会发生，直接丢掉（与清单里的快捷按钮同一条规则：
 * 界面上不留点不动的项）；整块为空就当插件没给，页面回落到「按钮暂无可用条目」。
 */
function menusOf(value: unknown): Record<string, PluginPanelMenuItem[]> | undefined {
  const menus: Record<string, PluginPanelMenuItem[]> = {};
  for (const [rawKey, rawItems] of Object.entries(record(value))) {
    const key = text(rawKey, 40);
    if (!key) continue;
    const items: PluginPanelMenuItem[] = [];
    for (const entry of list(rawItems).slice(0, MAX_MENU_ITEMS)) {
      const item = record(entry);
      const label = text(item.label, 60);
      const action = text(item.action, MAX_ACTION_ID);
      if (!label || !action) continue;
      const detail = text(item.detail, MAX_MENU_DETAIL);
      const itemKey = text(item.key, MAX_MENU_KEY);
      items.push({ label, action, ...(detail ? { detail } : {}), ...(itemKey ? { key: itemKey } : {}) });
    }
    if (items.length > 0) menus[key] = items;
    if (Object.keys(menus).length >= MAX_MENUS) break;
  }
  return Object.keys(menus).length > 0 ? menus : undefined;
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
  const newSession = normalizePluginNewSession(raw.newSession);
  const dialog = dialogOf(raw.dialog);
  const openPath = openPathOf(raw.openPath);
  const openReview = openReviewOf(raw.openReview);
  return {
    ...(message ? { message } : {}),
    ...(compose ? { compose } : {}),
    ...(newSession ? { newSession } : {}),
    ...(dialog ? { dialog } : {}),
    ...(openPath ? { openPath } : {}),
    ...(openReview ? { openReview } : {}),
  };
}

function openReviewOf(value: unknown): PluginPanelOpenReview | undefined {
  const raw = record(value);
  const cwd = text(raw.cwd, MAX_PATH);
  if (!cwd) return undefined;
  // 不替插件补一个默认基线：仓库的默认分支可能是 `main`，编成 `master` 会让宿主落进
  // 「无法解析基线」并退化成空 diff。缺省交给 Git 侧按远端默认分支解析。
  const base = text(raw.base, 120);
  const head = text(raw.head, 120);
  const label = text(raw.label, 80);
  return {
    cwd,
    ...(base ? { base } : {}),
    ...(head ? { head } : {}),
    ...(label ? { label } : {}),
  };
}

function openPathOf(value: unknown): PluginPanelOpenPath | undefined {
  if (typeof value === 'string') {
    const path = text(value, MAX_PATH);
    return path ? { path } : undefined;
  }
  const raw = record(value);
  const path = text(raw.path, MAX_PATH);
  if (!path) return undefined;
  const line = Number(raw.line);
  return {
    path,
    ...(Number.isFinite(line) && line > 0 ? { line: Math.floor(line) } : {}),
    ...(raw.focus === true ? { focus: true } : {}),
  };
}

function dialogCellOf(value: unknown): PluginPanelDialogCell | null {
  // 纯字符串是常见写法（表头下的普通列），别强迫插件给每一格都包一层对象
  if (typeof value === 'string') {
    const cellText = text(value, MAX_TEXT);
    return cellText ? { text: cellText } : null;
  }
  const raw = record(value);
  const cellText = text(raw.text, MAX_TEXT);
  if (!cellText) return null;
  const link = text(raw.link, MAX_CELL_LINK);
  return {
    text: cellText,
    ...(link ? { link } : {}),
    ...(tone(raw.tone) ? { tone: tone(raw.tone) } : {}),
  };
}

/**
 * 弹窗的归一化：没有标题就什么都不画。
 *
 * 正文与表格都是可选的，但至少要有一样，否则这个弹窗只剩标题（那时它的意义就是一句
 * message）。每行裁到列数、空行丢掉；单格认不出就当空格——表结构本身不该因为一格畸形而消失。
 */
function dialogOf(value: unknown): PluginPanelDialog | undefined {
  const raw = record(value);
  const title = text(raw.title, 60);
  if (!title) return undefined;
  const columns = list(raw.columns)
    .slice(0, MAX_DIALOG_COLUMNS)
    .map((column) => text(column, 30))
    .filter(Boolean);
  const body = text(raw.text, MAX_DIALOG_TEXT);
  if (columns.length === 0 && !body) return undefined;
  const rows = list(raw.rows)
    .slice(0, MAX_DIALOG_ROWS)
    .map((row) => {
      const cells = list(row).slice(0, columns.length).map((cell) => dialogCellOf(cell));
      if (!cells.some((cell) => cell !== null)) return null;
      // 补齐到列数：宿主按列画格子，短行不该让后面的列错位
      return columns.map((_, index) => cells[index] ?? { text: '' });
    })
    .filter((row): row is PluginPanelDialogCell[] => row !== null);
  const subtitle = text(raw.subtitle, 200);
  const note = text(raw.note, 400);
  return {
    title,
    columns,
    rows,
    ...(body ? { text: body } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(note ? { note } : {}),
  };
}
