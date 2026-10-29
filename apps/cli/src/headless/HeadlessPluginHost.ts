import { APP_NAME } from '@packages/mica-config/brand.js';
import { readActiveProviderConfig } from '@packages/mica-config/index.js';
import type { CommandRegistry } from '@packages/mica-commands/index.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type {
  HookRegistry,
  MicaPlugin,
  PluginPanelRegistry,
  PluginManager,
  PluginBaseContext,
  ServiceContainer,
} from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type {
  MessageQueueService,
  RuntimeEventBus,
  RuntimeInput,
  SubmitOptions,
  SubmitResult,
} from '@packages/mica-runtime/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { configureIterationRewrite, registerIterationRewrite } from '../agent/iterationRewrite.js';
import { createPluginSubagentHost } from '../agents/PluginSubagentHost.js';
import { createPluginModels, recordPluginModelUsage } from '../plugins/pluginModels.js';
import type { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import type { SessionController } from '../session/SessionController.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { createPluginPaths } from '../plugins/pluginPaths.js';
import {
  setupCommandMemory,
  setupMessageQueue,
  setupMicaCodeAppNotify,
  setupSessionAutonomy,
} from '@packages/mica-builtin-commands/index.js';
import { officialPlugins } from '@packages/mica-official-plugins/index.js';
import { readDisabledPluginIds } from '@packages/mica-plugin/index.js';
import { createHeadlessRuntimeServices } from './headlessRuntimeServices.js';
import { TurnNoticeLog } from '../runtime/turnNotices.js';
import type { HeadlessTurnStartResult } from '../runtime/HeadlessTurnExecutor.js';

export type HeadlessPluginHostOptions = {
  hooks: HookRegistry;
  agent: AgentRuntime;
  sessionController: SessionController;
  subagentTasks: SubagentTaskManager;
  isBusy: () => boolean;
  /**
   * 这次运行是一次性任务（`mica exec`）还是常驻会话（app-server）。
   *
   * 会改变成本或输出的插件（自动压缩）只在常驻会话里生效：一次性运行没有第二轮，
   * 压缩历史只会改变这一次的开销与结果，基准测试不能被它悄悄影响。
   */
  oneShot?: boolean;
  /**
   * 运行在 desktop 宿主里（Electron 壳 / Web 运行时的 app-server 子进程）。
   *
   * 决定插件能不能拿到 `desktop` 能力面：只有桌面端能看到插件声明的菜单页面、
   * 打开系统设置页，所以依赖它的插件在 CLI / TUI / exec 里整插件跳过，而不是
   * 装载成功却什么都做不了。
   */
  desktopHost?: boolean;
  /**
   * 是否加载 `$MICA_HOME/plugins` 下的用户插件。
   *
   * 常驻宿主（`mica app-server`）要加载；`mica exec` 这类一次性运行不加载，避免插件的
   * 定时器、外部命令与额外模型请求混进一次基准运行。
   */
  loadUserPlugins?: boolean;
  submit: (
    text: string,
    options?: { queueMode?: 'after_iteration' | 'after_turn'; displayText?: string },
  ) => Promise<SubmitResult>;
};

export type HeadlessPluginHost = {
  hooks: HookRegistry;
  services: ServiceContainer;
  commands: CommandRegistry;
  events: RuntimeEventBus;
  plugins: PluginManager;
  /** 对话右侧面板的登记表：协议层按 pluginId 取视图、转发动作。 */
  panels: PluginPanelRegistry;
  /** Single-slot queue shared with the HeadlessTurnExecutor. */
  queue: MessageQueueService;
  getCurrentSessionId(): string;
  /** Persisted conversation messages: provider history + plugin notices. */
  getConversationMessages(extra?: MicaUiConversationMessage[]): MicaUiConversationMessage[] | undefined;
  /** Session notices (retry hints, failures, command results), never in the provider history. */
  notices: { ensure(): TurnNoticeLog };
  emitRuntimeStart(): Promise<void>;
  emitRuntimeStop(): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Bridges a HeadlessTurnExecutor.start() result into the plugin-facing
 * SubmitResult shape, so plugins (message-queue and friends) can submit
 * inputs through ctx.runtime.submit exactly like in the interactive runtime.
 *
 * A `busy-remote` start (another process owns the session's turn lease) is
 * reported as `busy` too: the plugin's input was not accepted, and the desktop
 * app surfaces the same state through the turn-level rejection.
 */
export async function startAsSubmit(
  start: (input: RuntimeInput) => Promise<HeadlessTurnStartResult>,
  text: string,
  options?: SubmitOptions,
): Promise<SubmitResult> {
  const result = await start(micaRuntime.createRuntimeInput(text, 'plugin', options));
  if (result === 'rejected' || result === 'busy-remote') return { ok: false, reason: 'busy' };
  return { ok: true, handled: result === 'queued', queued: result === 'queued' };
}

/**
 * Runs the same built-in plugins as the interactive application, minus the
 * ones that are inherently tied to the terminal UI or to CLI arguments:
 *
 * - MCP stays hand-managed by each headless entry point (it accepts
 *   --mcp-config / --strict-mcp-config / --mcp-init-timeout-ms);
 * - file-mention and the command plugins (/model, /compact, ...) are
 *   input-box features and have no headless equivalent;
 * - user file plugins ($MICA_HOME/plugins) are not scanned.
 *
 * Everything that shapes the agent's capabilities is shared: session_* tools,
 * message queueing, the command-memory system-prompt guidance, todo_write and
 * the app-notify hooks.
 */
export function createHeadlessPluginHost(options: HeadlessPluginHostOptions): HeadlessPluginHost {
  const { hooks, agent, sessionController, subagentTasks } = options;
  configureIterationRewrite({
    mode: options.oneShot ? 'one-shot' : 'session',
    resolveSessionId: () => sessionController.getCurrentSessionId(),
    onError: (error, pluginId) => {
      const message = error instanceof Error ? error.message : String(error);
      micaPlugin.createPluginLogger(pluginId).error('plugin:iteration-rewrite-failed', { error: message });
      micaPlugin.writePluginHealth(pluginId, { level: 'error', message: `模型请求重写失败：${message}` });
    },
  });
  const services = new micaPlugin.ServiceContainer();
  const commands = new micaCommands.CommandRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const plugins = new micaPlugin.PluginManager();
  const panels = new micaPlugin.PluginPanelRegistry();
  const queue = new micaRuntime.MessageQueueService();
  // Notices live in the session file's conversationMessages, not in the
  // provider history: they are display-only and never reach the model.
  const noticeLog = new TurnNoticeLog(() => agent.toConversationMessages());
  let noticesSessionId: string | null = null;
  const notices = {
    ensure(): TurnNoticeLog {
      // A resumed session (or a /new) brings its own persisted notices.
      const sessionId = sessionController.getCurrentSessionId();
      if (sessionId !== noticesSessionId) {
        noticesSessionId = sessionId;
        noticeLog.restore(sessionController.load(sessionId)?.snapshot.conversationMessages);
      }
      return noticeLog;
    },
  };

  const runtimeServices = createHeadlessRuntimeServices({
    agent,
    sessionController,
    subagentTasks,
    notices,
    isBusy: options.isBusy,
    submit: options.submit,
  });
  // headless 下 `agent` 就是当前会话的 agent：没有多会话菜单，所以它就是默认 owner。
  const pluginSubagents = createPluginSubagentHost({
    defaultAgent: agent,
    taskManager: subagentTasks,
    resolveCurrentAgent: () => agent,
    // 旁问不属于任何 turn：记完立刻落盘，否则重启后这次开销就没了。
    persistUsage: (owner) => {
      if (owner.isRunning) return;
      sessionController.saveCurrent({ allowEmpty: true });
    },
  });

  const hostRegistration = services.register(commandHostToken, {
    agent,
    sessionController,
    services: runtimeServices,
    registerCommand(ctx, command, commandOptions = {}) {
      const disposable = ctx.commands.register({
        name: command.name,
        description: command.description,
        completionItems: command.completionItems,
        scope: 'local-only',
        allowDuringTurn: commandOptions.allowDuringTurn,
        pluginId: ctx.pluginId,
        async handler(_commandCtx, args) {
          await command.action(args || undefined);
          return { ok: true };
        },
      });
      ctx.onDispose(() => disposable.dispose());
    },
  });
  plugins.register({
    id: 'builtin.headless-command-host',
    name: 'Headless Command Host',
    priority: -1000,
    required: true,
    setup(ctx) {
      ctx.onDispose(() => hostRegistration.dispose());
    },
  });

  const builtinPlugins: Array<{ id: string; name: string; required?: boolean; setup: MicaPlugin['setup'] }> = [
    { id: 'runtime.messageQueue', name: 'Message Queue', setup: setupMessageQueue },
    { id: 'command-memory', name: 'Command Memory', setup: setupCommandMemory },
    { id: 'session-autonomy', name: 'Session Autonomy', setup: setupSessionAutonomy },
    // 笔记工具与 prompt 注入在 TUI / app-server / exec 三端必须一致：只注册在一处，
    // 会出现「桌面端能记、headless 记不了」的不对称。
    { id: 'builtin.mica-code-app-notify', name: `Built-in ${APP_NAME} App Notify`, setup: setupMicaCodeAppNotify },
  ];
  for (const plugin of builtinPlugins) {
    plugins.register({
      id: `builtin.${plugin.id}`,
      name: `Built-in ${plugin.name}`,
      required: plugin.required ?? false,
      setup: plugin.setup,
    });
  }
  const disabledPlugins = readDisabledPluginIds();
  for (const plugin of officialPlugins) {
    if (disabledPlugins.has(plugin.id)) continue;
    plugins.register(plugin);
  }

  // Persisted conversation = provider history + notices threaded back into the
  // position they were created at (see TurnNoticeLog), matching the
  // interactive session's uiState without rendering anything.
  // An empty list must stay "unset": SessionController.saveCurrent treats an
  // empty conversation as "delete this session" unless allowEmpty is passed.
  const getConversationMessages = (extra?: MicaUiConversationMessage[]): MicaUiConversationMessage[] | undefined => {
    const messages = notices.ensure().compose(extra);
    return messages.length > 0 ? messages : undefined;
  };

  const paths = createPluginPaths();

  const baseContext: PluginBaseContext = {
    paths,
    ...(options.desktopHost ? { desktop: { host: 'desktop' as const } } : {}),
    // 面板是「插件给数据、宿主画出来」的界面，只有桌面宿主有位置渲染它；CLI / exec 里
    // 传了登记表也没人读，所以跟着 desktopHost 一起开关。
    ...(options.desktopHost ? { desktopPanels: panels } : {}),
    services,
    hooks,
    commands,
    events,
    // 一个进程一条会话：owner 在这里不参与解析，改名也只会落到当前会话上。
    session: {
      describe: () => ({
        id: sessionController.getCurrentSessionId(),
        title: sessionController.getCurrentDisplayTitle(),
        titleSource: sessionController.getCurrentTitleSource(),
        cwd: process.cwd(),
        role: agent.role,
      }),
      messages: () => agent.toConversationMessages(),
      rename: (title, renameOptions) =>
        sessionController.renameCurrent(title, { source: renameOptions?.source ?? 'auto' }),
    },
    sessionStateFor: (pluginId) => ({
      get: () => agent.getPluginState(pluginId),
      // 没有会话就抛出：静默丢弃写入会让插件以为状态存住了，实际下一轮读回 undefined。
      set: (value) => {
        if (!agent.setPluginState) throw new Error(`session state unavailable for ${pluginId}`);
        agent.setPluginState(pluginId, value);
      },
      clear: () => agent.clearPluginState?.(pluginId),
    }),
    sessionSettingsFor: (pluginId) => ({
      read: () => agent.getPluginSessionSettings?.(pluginId),
      write: (value) => {
        if (!agent.setPluginSessionSettings) throw new Error(`session settings unavailable for ${pluginId}`);
        agent.setPluginSessionSettings(pluginId, value);
      },
    }),
    promptSections: agent.promptSections,
    agentRegistry: {
      mode: options.oneShot ? 'one-shot' : 'session',
      onIterationRewrite: (pluginId, handler) => registerIterationRewrite(pluginId, handler),
    },
    subagentsFor: (pluginId) => pluginSubagents.forPlugin(pluginId),
    // 插件自己的模型请求同样要记账：app-server 就是常驻会话，漏了这一笔 Stats 会少算。
    pluginModels: createPluginModels({
      record: (entry) =>
        recordPluginModelUsage(entry, {
          agent,
          save: () => sessionController.saveCurrent({ allowEmpty: true }),
        }),
      // 「跟随主配置」= 这条会话正在用的 provider；会话没起来时退回全局默认。
      resolveMainProvider: (model) => {
        if (model) return readActiveProviderConfig({ model });
        const snapshot = agent?.getSnapshot?.();
        return readActiveProviderConfig(snapshot ? { providerId: snapshot.providerId, model: snapshot.model } : {});
      },
    }),
    runtime: {
      submit: options.submit,
      queue: {
        isBusy: () => options.isBusy(),
        enqueue: (_owner, input) => queue.enqueue(input),
        dequeue: () => queue.dequeue(),
        list: () => queue.list(),
      },
    },
    tools: {
      register: (tool, toolOptions = {}) => {
        micaTools.registerRuntime(tool, { primaryAgentOnly: toolOptions.primaryAgentOnly });
        return {
          dispose: () => {
            micaTools.unregisterRuntime(tool);
          },
        };
      },
    },
    ui: {
      submit() {},
      showMessage() {},
      notice(content, noticeOptions = {}) {
        runtimeServices.showNotice(content, undefined, {
          ...(noticeOptions.variant ? { variant: noticeOptions.variant } : {}),
          ...(noticeOptions.command ? { command: noticeOptions.command } : {}),
          ...(noticeOptions.surface ? { surface: noticeOptions.surface } : {}),
          ...(noticeOptions.status ? { status: noticeOptions.status } : {}),
        });
      },
      status: {
        upsert() {},
        remove() {
          return true;
        },
      },
      input: {
        getText: () => '',
        registerFileMentionProvider: () => ({ dispose() {} }),
      },
    },
    git: {
      text: gitText,
      formatError: formatExecError,
    },
    logger: {
      info() {},
      warn(message, data) {
        console.error(`[plugin] ${message}`, data ?? '');
      },
      error(message, data) {
        console.error(`[plugin] ${message}`, data ?? '');
      },
    },
  };

  // `mica app-server`（桌面端的常驻宿主）也要装用户插件：桌面入口、对话右侧面板都要靠
  // 它。`mica exec` 是一次性运行，不装——那边任何定时器/外部命令都会污染一次基准运行。
  const setupPromise = (async () => {
    const userPlugins = options.loadUserPlugins
      ? await micaPlugin.loadUserPlugins(plugins, { pluginsDir: paths.plugins })
      : null;
    const report = await plugins.setupAll(baseContext);
    if (userPlugins) {
      micaPlugin.writeUserPluginStatus({
        pluginsDir: paths.plugins,
        configDir: paths.config,
        filePlugins: userPlugins,
        setupReport: report,
      });
    }
    return report;
  })();

  const host: HeadlessPluginHost = {
    hooks,
    services,
    commands,
    events,
    plugins,
    panels,
    queue,
    getCurrentSessionId: () => sessionController.getCurrentSessionId(),
    getConversationMessages,
    notices,
    async emitRuntimeStart() {
      await setupPromise;
      await hooks.emit('runtime:start', { runtime: host });
    },
    async emitRuntimeStop() {
      await hooks.emit('runtime:stop', { runtime: host });
    },
    async dispose() {
      await plugins.disposeAll();
      pluginSubagents.disposeAll();
    },
  };
  return host;
}
