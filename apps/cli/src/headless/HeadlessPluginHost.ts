import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_NAME, resolveMicaHome } from '@packages/mica-config/brand.js';
import type { CommandRegistry } from '@packages/mica-commands/index.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type {
  HookRegistry,
  MicaPlugin,
  PluginManager,
  PluginContext,
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
import type { SubagentTaskManager } from '../agents/SubagentTaskManager.js';
import type { SessionController } from '../session/SessionController.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import {
  setupCommandMemory,
  setupMessageQueue,
  setupMicaCodeAppNotify,
  setupSessionAutonomy,
  setupSessionNotes,
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
  const services = new micaPlugin.ServiceContainer();
  const commands = new micaCommands.CommandRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const plugins = new micaPlugin.PluginManager();
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
    { id: 'session-notes', name: 'Session Notes', setup: setupSessionNotes },
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

  const paths = createHeadlessPluginPaths();

  const baseContext: Omit<PluginContext, 'pluginId' | 'onDispose'> = {
    paths,
    services,
    hooks,
    commands,
    events,
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

  const setupPromise = plugins.setupAll(baseContext);

  const host: HeadlessPluginHost = {
    hooks,
    services,
    commands,
    events,
    plugins,
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
    },
  };
  return host;
}

function createHeadlessPluginPaths() {
  const home = homedir();
  const config = resolveMicaHome();
  return {
    home,
    config,
    plugins: join(config, 'plugins'),
  };
}
