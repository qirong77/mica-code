import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { Disposable } from '@packages/mica-common/index.js';
import type { RuntimeEventBus, RuntimePluginQueue, SubmitOptions, SubmitResult } from '@packages/mica-runtime/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { HookRegistry } from './HookRegistry.js';
import type { ServiceContainer } from './ServiceContainer.js';
import type { PluginIterationRewriter } from './PluginAgent.js';
import type { PluginPromptSection } from './PluginPrompt.js';
import type { PluginSessionStateApi } from './PluginSessionState.js';
import type { PluginSessionSettingsApi } from './PluginSessionSettings.js';
import type { PluginSubagentApi } from './PluginSubagents.js';
import type { PluginModelsApi } from './PluginModels.js';
import type { PluginLlmApi } from './PluginLlm.js';
import type { PluginHealthStore } from './PluginHealth.js';
import type { PluginSettingIssue, PluginSettingValues } from './PluginSettings.js';
import type { PluginDesktopApi, PluginSkillsApi } from './PluginDesktop.js';
import type React from 'react';

export type PluginStatusItem = {
  id: string;
  component: React.ComponentType;
};

export type PluginToolRegistrationOptions = {
  icon?: string;
  primaryAgentOnly?: boolean;
};

export type PluginFileMentionItem = {
  path: string;
  label?: string;
  description?: string;
  labelHighlights?: number[];
};

export type PluginFileMentionProvider = (query: string) => Promise<PluginFileMentionItem[]>;

/** 插件看到的会话身份：改名要用到的三样东西。 */
export type PluginSessionInfo = {
  id: string;
  title: string;
  /** `manual` 表示用户手动改过标题，插件的自动改名不应覆盖它。 */
  titleSource?: 'derived' | 'auto' | 'manual';
  /**
   * 会话的工作目录（绝对路径）。
   *
   * 会话切目录（`/cd`、resume 到会话自己的目录）会改变它，所以插件应当每次读，
   * 不要缓存成进程启动时的 cwd。按工作区归档的插件（记忆、统计）靠它区分项目。
   */
  cwd?: string;
  /**
   * 这条会话正在使用的角色名（`$MICA_HOME/role/<name>.md`，`default` 是内置的）。
   *
   * 需要在旁问里带上「主流程以谁的规则在回答」的插件读它，再自己取角色正文；
   * 与 `/role` 切换同步，不要在插件里缓存成启动时的值。
   */
  role?: string;
};

/**
 * 插件往会话里追加一条 notice。
 *
 * notice 只属于界面：它落在会话的对话消息里（跟着会话保存、resume 后还在），但
 * **不进 provider history**，模型看不到它。所以它是插件汇报长期结果的地方——
 * 不要用 `ui.showMessage`（那是一条几秒后消失的提示条）代替。
 */
export type PluginNoticeOptions = {
  /** 归到哪条命令下；同一个 `command` 的 running notice 会被下一条替换。 */
  command?: string;
  status?: 'running' | 'success' | 'warning' | 'error' | 'info';
  /**
   * `command_panel` 把内容固定在输入框上方（运行中的进度），收尾时发一条不带
   * surface 的同 `command` notice 就把它撤掉并落进对话。
   */
  surface?: 'conversation' | 'command_panel';
  variant?: 'commit' | 'config' | 'compact' | 'error';
  /** 写进哪条会话；不传就是当前会话。句柄来自 `ctx.session` 的 owner。 */
  owner?: unknown;
};

export type PluginSessionRenameOptions = {
  /** `turn:after` 事件里的 owner；不给就是当前会话。 */
  owner?: unknown;
  /** 默认 `auto`。`manual` 只有用户显式操作（`/rename`、桌面重命名）才该用。 */
  source?: 'auto' | 'manual';
};

/**
 * 会话访问面。
 *
 * 插件只拿得到「当前这一条会话」的只读视图和改名入口：写历史、改快照、跨会话都留
 * 在内核里，否则一个插件就能破坏 turn 的时序假设。
 */
export type PluginSessionApi = {
  describe(owner?: unknown): PluginSessionInfo | null;
  /** 已提交的对话消息（UI 视角，不含 notice 与工具消息）。 */
  messages(owner?: unknown): MicaUiConversationMessage[];
  /**
   * 改名。
   *
   * 返回 false 的情况：没有会话、标题为空、`source: 'auto'` 但用户已经手动改过标题。
   * 拒绝比抛错好——自动改名失败不该中断 turn。
   */
  rename(title: string, options?: PluginSessionRenameOptions): boolean;
};

export type PluginContext = {
  pluginId: string;
  paths?: {
    home: string;
    config: string;
    plugins: string;
  };
  services: ServiceContainer;
  hooks: HookRegistry;
  commands: CommandRegistry;
  events: RuntimeEventBus;
  /**
   * 会话访问面。`exec` 的 headless 宿主也提供，只是没有 UI 侧的副作用。
   */
  session?: PluginSessionApi;
  /**
   * 本插件在**当前会话**里的持久状态。
   *
   * 存在会话快照的 `pluginState[pluginId]` 里，因此跨 compact 存活、随 resume/fork
   * 带回、新会话清空。已经在 turn 中改动的内容会跟着本轮 checkpoint 落盘；在 turn
   * 之外（例如协议方法里）改动，需要调用方自己触发保存。
   */
  sessionState?: PluginSessionStateApi;
  /**
   * 本插件的设置值，含**当前会话**的覆盖。
   *
   * `ctx.settings.get()` 读的是全局那一份；这里读的是「这个会话实际会用的值」——
   * 用户在会话设置里改过的项优先，其余跟随全局。要区分两者用 `overrides()`。
   *
   * 只有清单里标了 `perSession` 的字段能覆盖，所以两者在没标 `perSession` 的插件里
   * 永远相等。
   */
  sessionSettings?: PluginSessionSettingsApi;
  /**
   * 向 system prompt 贡献段落。每轮重新渲染，空串表示本轮不贡献。
   *
   * 段落追加在 base prompt 与 `system-prompt:build` pipeline 之后——这里是最容易
   * 随会话变化的内容，放在末尾才不会让前面稳定的前缀跟着 prompt cache 失效。
   */
  prompt?: {
    section(section: PluginPromptSection): Disposable;
  };
  /**
   * 注册 skill：插件自带的内置能力（正文随包分发，不在用户的 skills 目录里）。
   *
   * 注册进来的 skill 与磁盘扫描出来的完全同权：进 system prompt 索引、`skill` 工具
   * 能加载、`/skills` 面板与配置页能看到、会话能力开关能关掉它。磁盘上的同名 skill
   * 优先，被遮蔽的条目从 `skipped` 读出来，插件应当把它报成一条用户可见的状态。
   */
  skills: PluginSkillsApi;
  /**
   * desktop 宿主身份。只有桌面端的运行时（Electron 壳 / Web 运行时）往 app-server
   * 传了标记时才有值；CLI、TUI、`mica exec` 里为 undefined。
   *
   * 运行条件（清单 `desktop.checks`）由桌面端探测并渲染，这里只让插件判断「我是不是
   * 跑在能兑现这些条件的宿主里」——依赖它的插件用 `requires: ['desktop']` 声明，
   * 其它宿主会整插件跳过，而不是让插件在运行期踩空。
   */
  desktop?: PluginDesktopApi;
  /**
   * 与模型请求交互的入口：在迭代边界重写「接下来要发送的历史」。
   *
   * 只在常驻会话的宿主里提供（TUI / app-server）。`mica exec` 这样的
   * 一次性运行不提供——那边任何改变成本或输出的策略都会污染基准测试。
   */
  agent?: {
    /** 宿主形态，与 `PluginIterationRewriter.mode` 同义：`one-shot` 没有下一轮。 */
    readonly mode: 'session' | 'one-shot';
    onIterationRewrite(handler: PluginIterationRewriter): Disposable;
  };
  /**
   * 委派子代理：注册子代理类型、前台/后台跑一个、管后台任务。
   *
   * 机制在宿主（建子代理、用量记账、路径租约、完成后回注通知），策略在插件
   * （有哪些类型、工具怎么描述、什么时候委派）。内核里不出现任何具体委派策略。
   */
  subagents?: PluginSubagentApi;
  /** Host-scoped helper model requests; usage is attributed to the calling plugin. */
  models?: PluginModelsApi;
  /**
   * 插件自己调模型时的配置 + 请求（清单 `llm` 声明的那一份）。
   *
   * 比 `ctx.models` 高一层：它把「用哪个地址/Key/协议/模型」也收进来，插件不必自己拼
   * 四个字段、也不必各写一遍「没配置就别发」。记账仍走 `ctx.models`。
   */
  llm?: PluginLlmApi;
  /**
   * 清单里声明的设置项的当前值（`$MICA_HOME/plugin-settings/<id>.json`）。
   * 配置页改完立刻生效：读的时候按文件 mtime 判断，不需要重开会话。
   */
  settings: {
    /** 设置文件路径；宿主没有 config 目录时为 null。 */
    readonly path: string | null;
    get(): PluginSettingValues;
    /**
     * 当前配置的校验结果（空数组表示可用）。
     *
     * 与配置页保存时的校验是同一份规则，所以不会出现「页面说已保存、插件说不能用」。
     * 插件应当用它决定「要不要跳过本轮工作」，并把原因上报到 `ctx.health`。
     */
    validate(): PluginSettingIssue[];
  };
  /**
   * 插件自报状态（正常 / 需要配置 / 出错）。
   *
   * 插件最典型的坏法是**静默**的：配置没填、接口连不上、上一次失败，这些都不该让插件
   * 崩溃，但也不该只留在日志里。上报之后配置页能看到「这个插件现在什么状态」。
   */
  health: PluginHealthStore;
  runtime?: {
    submit(text: string, options?: SubmitOptions): Promise<SubmitResult>;
    queue?: RuntimePluginQueue;
  };
  tools?: {
    register(tool: MicaTool, options?: PluginToolRegistrationOptions): Disposable;
  };
  ui?: {
    submit(text: string, options?: { displayText?: string }): void;
    showMessage(text: string, ttl?: number): void;
    notice(content: string, options?: PluginNoticeOptions): void;
    status?: {
      upsert(item: PluginStatusItem): void;
      remove(id: string): boolean;
    };
    input?: {
      getText(): string;
      registerFileMentionProvider(provider: PluginFileMentionProvider): Disposable;
    };
    [key: string]: unknown;
  };
  git?: {
    text(args: string[], options?: { timeout?: number }): string;
    formatError(error: unknown): string;
  };
  logger: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
    error(event: string, data?: unknown): void;
  };
  onDispose(dispose: () => void | Promise<void>): void;
};
