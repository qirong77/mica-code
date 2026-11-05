import type { Skill } from '@packages/mica-skills/index.js';
import type { PluginPanelHandler, PluginPanelRegistration } from './PluginPanel.js';
import type {
  PluginSessionMenuHandler,
  PluginSessionMenuRegistration,
} from './PluginSessionMenu.js';

/**
 * 插件在 desktop 宿主里的运行条件。
 *
 * 插件代码跑在 `mica app-server` 子进程里，桌面端的界面在另一个进程里。所以界面**不是
 * 插件渲染的**，而是清单声明的数据：插件只说「我依赖哪几项运行条件」，宿主负责探测、
 * 在插件自己的设置页里显示状态、并给出「去哪里开」的入口。
 */

/**
 * desktop 宿主能报告的检查项目录（单一事实来源）。
 *
 * 插件在清单里只声明需要哪几项，宿主负责探测当前状态、给出「去哪里修」的入口。
 * 新增一项 = 在宿主里实现一个探测器，再在这里登记；插件侧无需改代码。
 */
export const DESKTOP_CHECKS = [
  {
    id: 'accessibility',
    label: '辅助功能',
    description:
      '操作元素树、发送键鼠事件都需要它；没开时 AX 命令直接报错，鼠标事件会被静默丢弃。改完权限要重启 Mica。',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  },
  {
    id: 'screen-recording',
    label: '屏幕录制',
    description: '截图与读屏需要它；没开时截出来的是桌面壁纸，不是窗口内容。改完权限要重启 Mica。',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  },
  {
    id: 'command-line-tools',
    label: '命令行工具',
    description: '辅助功能助手需要 clang 编译一次；缺 Xcode Command Line Tools 时执行 xcode-select --install。',
    pane: undefined,
  },
  {
    id: 'full-disk-access',
    label: '全磁盘访问',
    description:
      '读别的应用自己的数据（Chrome 的 cookie 库、别的浏览器的配置）需要它；没开时那些文件一律「Operation not permitted」。改完权限要重启 Mica。',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  },
] as const;

export type DesktopCheckId = (typeof DESKTOP_CHECKS)[number]['id'];

export type DesktopCheckDefinition = (typeof DESKTOP_CHECKS)[number];

export const DESKTOP_CHECK_IDS: DesktopCheckId[] = DESKTOP_CHECKS.map((check) => check.id);

export function isDesktopCheckId(value: unknown): value is DesktopCheckId {
  return typeof value === 'string' && (DESKTOP_CHECK_IDS as string[]).includes(value);
}

/**
 * 清单里的 `desktop` 段：插件声明自己依赖哪些运行条件。
 *
 * 只声明 id，文案、探测方式与系统设置入口都归 `DESKTOP_CHECKS` 所有——插件不该也无法
 * 自己探测这些（TCC 权限属于桌面应用进程，app-server 子进程拿不到真实状态）。
 */
export type PluginDesktopRequirements = {
  /** 顺序即设置页上的显示顺序。 */
  checks: DesktopCheckId[];
};

/**
 * 桌面端入口（清单 `desktop.entry`）。
 *
 * 插件想让自己的能力以「一行入口 + 点开的卡片 / 整页」出现在桌面端时声明它，宿主按
 * 约定去插件目录找 `desktop.jsx`（default 导出 React 组件）渲染卡片内容——宿主因此
 * 不需要认识任何具体插件。
 *
 * 只对**随包插件**生效：桌面端的页面是构建期打包的，`plugins/<id>/desktop.jsx` 只有在
 * 打包时被收录才会被加载。用户插件声明这一段不会渲染出入口，`$MICA_HOME/plugins` 是
 * 运行时才出现的目录，页面那边没有它的模块。
 */
export type PluginDesktopEntry = {
  /** 入口显示的文案；清单没写时用插件的 name。`header` 形态把它收进 tooltip。 */
  label: string;
  /**
   * 入口画在哪一侧。
   *
   * `sidebar` 是侧栏里的一行（带文案与 `summary`），`header` 是主区顶栏的一枚图标按钮：
   * 顶栏只有 32px 高、又要给窗口类图标留位置，所以那里只画图标。
   */
  placement: PluginEntryPlacement;
};

/** `desktop.entry.placement` 的取值（单一事实来源，清单解析与界面共用）。 */
export const PLUGIN_ENTRY_PLACEMENTS = ['sidebar', 'header'] as const;

export type PluginEntryPlacement = (typeof PLUGIN_ENTRY_PLACEMENTS)[number];

export function isPluginEntryPlacement(value: unknown): value is PluginEntryPlacement {
  return typeof value === 'string' && (PLUGIN_ENTRY_PLACEMENTS as readonly string[]).includes(value);
}

/**
 * 插件的整页视图（清单 `desktop.page`）。
 *
 * 与 `entry` 的卡片是两种形态，按内容选：卡片浮在侧栏行旁边、只有 320px 宽，适合「一眼看
 * 几行状态」；整页盖住整个窗口，适合时间轴、表格这类要宽度也要高度的东西。声明了 `page`
 * 之后，点侧栏那一行打开的是整页，不再有悬停卡片；没有 `entry` 时，整页只从配置页
 * 插件详情的「打开」按钮进入。
 *
 * 前端模块用 `Page` 命名导出渲染，此时 `default`（卡片）可以没有——页面本身就是入口。
 */
export type PluginDesktopPage = {
  /** 页面顶部显示的标题；清单没写时用 `entry.label`，没有入口时用插件名。 */
  title: string;
};
/**
 * 对话右侧的面板（清单 `desktop.panel`）。
 *
 * 与侧栏入口的区别：侧栏入口的卡片是插件自己的前端模块（只有随包插件才有），面板则是
 * **插件给数据、宿主画出来**，所以用户装在 `$MICA_HOME/plugins` 的插件也能有。
 *
 * `roles` 是显示条件：只有当前会话的角色命中时才出现，空数组表示任何角色都显示。角色是
 * 宿主自己的会话事实，插件不该（也没法）在页面里判断「现在是不是我要的那个角色」。
 */
export type PluginDesktopPanel = {
  /** 面板标题与入口按钮的文案；清单没写时用插件的 name。 */
  label: string;
  /** 显示条件：会话角色名（`$MICA_HOME/role/<name>.md`）。 */
  roles: string[];
  /**
   * 点入口时执行的动作（`PluginPanelHandler.action` 的 id），而不是打开面板。
   *
   * 有一类面板要回答的只有一句话：「手机现在能不能用」。为它开一整块抽屉、再让用户自己
   * 找那一行，比直接弹一个二维码更费事。声明它之后，入口（「+」菜单里的那一行）直接把
   * 这个动作交给插件，动作回的 `dialog` 由宿主弹出来；没声明时点击还是打开面板。
   *
   * 动作仍然要能在**没有视图**的情况下完成：点击那一刻宿主不会先取视图。
   */
  open?: string;
  /**
   * 面板以什么形态出现：`drawer` 贴着对话右侧（默认），`modal` 盖住整窗的弹窗。
   *
   * 抽屉适合「几行状态 + 一个开关」这种一瞥即走的面板；内容本身超过一屏（设置分组多、
   * 条目列表长）时抽屉太窄，读和点都费劲，那就声明 `modal`。这是纯呈现选择——同一份
   * 视图数据两种形态都画得出来，插件不需要为此改代码。
   */
  display: PluginPanelDisplay;
  /**
   * 视图里会带 `statusBar`（输入框上方那条常驻状态）。
   *
   * 声明它是因为状态栏必须在**没点开面板时也常驻可见**：宿主据此定期取一次视图，
   * 而不是等某个快捷按钮被 hover 才去问插件。没有快捷按钮的面板也要能被刷新，
   * 所以它独立于 `shortcuts`。
   */
  status: boolean;
  /**
   * 输入框上方那排快捷按钮，按声明顺序渲染。
   *
   * 声明它是因为「一个面板」通常承载两类不同的东西：**马上要做的一件事**（立刻检查）
   * 和**要改的配置**（频道设置）。把它们都塞进一块抽屉，用户每次都得先打开抽屉、
   * 找到那一块、再点按钮。快捷按钮让常用动作一步到位，配置项各开各的那一块。
   */
  shortcuts: PluginPanelShortcut[];
};

/** `desktop.panel.display` 的取值（单一事实来源，清单解析与界面共用）。 */
export const PLUGIN_PANEL_DISPLAYS = ['drawer', 'modal'] as const;

export type PluginPanelDisplay = (typeof PLUGIN_PANEL_DISPLAYS)[number];

/**
 * 一个快捷按钮，四种形态里选一种：
 * - `action`：点了直接把该动作交给插件的 `action` 处理器（不打开面板）；
 * - `section`：点了打开面板并展开指定标题的那一块（`PluginPanelSection.title`）；
 * - `items`：悬停/点击展开一层**静态**菜单，条目各自是 action 或 section；
 * - `menu`：同样是一层菜单，但条目由插件在视图的 `menus[menu]` 里给（运行期才知道的
 *   内容：认领的开发副本、本机已配的通道）。
 *
 * 四种都给、或者一种都不给都算清单错误——宿主不知道该怎么表现，只能猜。
 *
 * 为什么需要分组：同一个能力面常常是「一个常用动作 + 它的配置」。两个按钮并排会一路
 * 把输入框上方挤满，名字还都很长；收进一层菜单之后入口只剩一个词，悬停就看到两件事。
 */
export type PluginPanelShortcut = {
  /** 可选的稳定标识，供视图的 shortcutStates 引用；同一插件内唯一。 */
  id?: string;
  label: string;
  action?: string;
  section?: string;
  menu?: string;
  items?: PluginPanelShortcutItem[];
};

/** 快捷按钮标识同时用作视图字典的键。 */
export function isValidPluginPanelShortcutId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

/** 静态菜单里的一项，语义与顶层快捷按钮一致（二选一）。 */
export type PluginPanelShortcutItem = {
  label: string;
  action?: string;
  section?: string;
};

/** 宿主实际提供给插件的 desktop 能力面。 */
export type PluginDesktopApi = {
  host: 'desktop';
  /**
   * 注册对话右侧那块面板。
   *
   * 只在清单声明了 `desktop.panel` 时可用：没声明就没有位置可画，静默接受注册会让插件
   * 以为自己的界面已经出现。一个插件只有一块面板，再注册会替换上一块。
   */
  panel?(handler: PluginPanelHandler): PluginPanelRegistration;
  /**
   * 注册会话右键菜单的动作处理器。
   *
   * 只在清单声明了 `desktop.sessionMenu` 时可用——菜单上有哪几项来自清单，点了做什
   * 么来自这里；没声明却接受注册，插件会以为菜单项已经出现，实际右键里什么都没有。
   */
  sessionMenu?(handler: PluginSessionMenuHandler): PluginSessionMenuRegistration;
};

/**
 * 插件注册给宿主的 skill。
 *
 * `baseDir` 必须是宿主真能读到的目录（skill 正文里引用的脚本都相对它解析），
 * 所以插件要把随包资源先落盘，再用落盘路径注册。
 */
export type PluginSkillDefinition = Skill;

export type PluginSkillRegistration = {
  dispose(): void;
  /** 没注册上的 skill 与原因；插件应当把它报成一条用户可见的状态。 */
  skipped: { name: string; reason: string }[];
};

export type PluginSkillRegistrationOptions = {
  /**
   * 只在这些会话角色里生效，空数组/缺省 = 所有角色。取值与 `desktop.panel.roles` 同一套
   * 角色名。
   *
   * 注册只发生在跑插件的那个进程里，而「一条 skill 属于谁」还要被不 setup 插件的宿主
   * 读到（桌面端给输入框做 `/` 补全时扫 `$MICA_HOME/plugin-skills` 索引）。角色因此随
   * 索引落盘，由读的一方按自己那个会话的角色过滤：不带角色，角色专属的 skill 会漏进别的
   * 角色的会话。
   */
  roles?: readonly string[];
};

export type PluginSkillsApi = {
  register(
    skill: PluginSkillDefinition,
    options?: PluginSkillRegistrationOptions,
  ): PluginSkillRegistration;
};
