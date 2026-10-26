import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { Disposable } from '@packages/mica-common/index.js';
import type { RuntimeEventBus, RuntimePluginQueue, SubmitOptions, SubmitResult } from '@packages/mica-runtime/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { HookRegistry } from './HookRegistry.js';
import type { ServiceContainer } from './ServiceContainer.js';
import type { PluginSettingValues } from './PluginSettings.js';
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
   * 清单里声明的设置项的当前值（`$MICA_HOME/plugin-settings/<id>.json`）。
   * 配置页改完立刻生效：读的时候按文件 mtime 判断，不需要重开会话。
   */
  settings: {
    /** 设置文件路径；宿主没有 config 目录时为 null。 */
    readonly path: string | null;
    get(): PluginSettingValues;
  };
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
