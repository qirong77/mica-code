import type { Skill } from '@packages/mica-skills/index.js';

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

/** 宿主实际提供给插件的 desktop 能力面：只表明身份，页面数据来自清单。 */
export type PluginDesktopApi = {
  host: 'desktop';
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

export type PluginSkillsApi = {
  register(skill: PluginSkillDefinition): PluginSkillRegistration;
};
