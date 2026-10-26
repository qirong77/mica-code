import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { Disposable } from '@packages/mica-common/index.js';
import type { RuntimeEventBus, RuntimePluginQueue, SubmitOptions, SubmitResult } from '@packages/mica-runtime/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { HookRegistry } from './HookRegistry.js';
import type { ServiceContainer } from './ServiceContainer.js';
import type { PluginPromptSection } from './PluginPrompt.js';
import type { PluginSessionStateApi } from './PluginSessionState.js';
import type { PluginHealthStore } from './PluginHealth.js';
import type { PluginSettingIssue, PluginSettingValues } from './PluginSettings.js';
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
   * 向 system prompt 贡献段落。每轮重新渲染，空串表示本轮不贡献。
   *
   * 段落追加在 base prompt 与 `system-prompt:build` pipeline 之后——这里是最容易
   * 随会话变化的内容，放在末尾才不会让前面稳定的前缀跟着 prompt cache 失效。
   */
  prompt?: {
    section(section: PluginPromptSection): Disposable;
  };
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
