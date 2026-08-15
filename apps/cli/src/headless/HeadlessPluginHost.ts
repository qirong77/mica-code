import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
import setupSessionAutonomy from '../../../../plugins/builtin/session-autonomy/SessionAutonomyPlugin.js';
import setupContextPressure from '../../../../plugins/builtin/context-pressure/ContextPressurePlugin.js';
import setupMessageQueue from '../../../../plugins/builtin/message-queue.js';
import setupCommandMemory from '../../../../plugins/builtin/command-memory.js';
import setupMicaCodeAppNotify from '../../../../plugins/builtin/mica-code-app-notify.mjs';
import { TodoPlugin } from '../../../../plugins/builtin/todo/TodoPlugin.js';
import { createHeadlessRuntimeServices, type HeadlessUiState } from './headlessRuntimeServices.js';

export type HeadlessPluginHostOptions = {
  hooks: HookRegistry;
  agent: AgentRuntime;
  sessionController: SessionController;
  subagentTasks: SubagentTaskManager;
  isBusy: () => boolean;
  /** Called after a session_* tool replaced the persisted history (e.g. app-server notifies its client). */
  onHistoryApplied?: () => void;
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
  getConversationMessages(): MicaUiConversationMessage[] | undefined;
  emitRuntimeStart(): Promise<void>;
  emitRuntimeStop(): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Bridges a HeadlessTurnExecutor.start() result into the plugin-facing
 * SubmitResult shape, so plugins (message-queue, context-pressure) can submit
 * inputs through ctx.runtime.submit exactly like in the interactive runtime.
 */
export async function startAsSubmit(
  start: (input: RuntimeInput) => Promise<'started' | 'queued' | 'rejected'>,
  text: string,
  options?: SubmitOptions,
): Promise<SubmitResult> {
  const result = await start(micaRuntime.createRuntimeInput(text, 'plugin', options));
  if (result === 'rejected') return { ok: false, reason: 'busy' };
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
 * the context-pressure reminder, message queueing, the command-memory
 * system-prompt guidance, TodoWrite and the app-notify hooks.
 */
export function createHeadlessPluginHost(options: HeadlessPluginHostOptions): HeadlessPluginHost {
  const { hooks, agent, sessionController, subagentTasks } = options;
  const services = new micaPlugin.ServiceContainer();
  const commands = new micaCommands.CommandRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const plugins = new micaPlugin.PluginManager();
  const queue = new micaRuntime.MessageQueueService();
  const uiState: HeadlessUiState = { conversationMessages: [] };

  const runtimeServices = createHeadlessRuntimeServices({
    agent,
    sessionController,
    subagentTasks,
    uiState,
    isBusy: options.isBusy,
    onHistoryApplied: options.onHistoryApplied,
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
    { id: 'context-pressure', name: 'Context Pressure', setup: setupContextPressure },
    { id: 'builtin.mica-code-app-notify', name: 'Built-in Mica Code App Notify', setup: setupMicaCodeAppNotify },
  ];
  for (const plugin of builtinPlugins) {
    plugins.register({
      id: `builtin.${plugin.id}`,
      name: `Built-in ${plugin.name}`,
      required: plugin.required ?? false,
      setup: plugin.setup,
    });
  }
  plugins.register(new TodoPlugin());

  // Persisted conversation = provider history + notices appended by plugins
  // (session_compact / session_rewrite results), matching the interactive
  // session's uiState without rendering anything.
  // An empty list must stay "unset": SessionController.saveCurrent treats an
  // empty conversation as "delete this session" unless allowEmpty is passed.
  const getConversationMessages = (): MicaUiConversationMessage[] | undefined =>
    uiState.conversationMessages.length > 0 ? uiState.conversationMessages : undefined;

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

  // Context pressure without the UI store: publish usage as an event so the
  // plugin's red-zone reminder works identically in TUI and headless modes.
  const onUsage = (usage: { totalTokens: number }): void => {
    events.publish({
      type: 'context:changed',
      tokens: usage.totalTokens,
      windowSize: agent.config.provider.contextWindowSize,
      owner: agent,
    });
  };
  agent.events.on('usage', onUsage);

  const host: HeadlessPluginHost = {
    hooks,
    services,
    commands,
    events,
    plugins,
    queue,
    getCurrentSessionId: () => sessionController.getCurrentSessionId(),
    getConversationMessages,
    async emitRuntimeStart() {
      await setupPromise;
      await hooks.emit('runtime:start', { runtime: host });
    },
    async emitRuntimeStop() {
      await hooks.emit('runtime:stop', { runtime: host });
    },
    async dispose() {
      agent.events.off('usage', onUsage);
      await plugins.disposeAll();
    },
  };
  return host;
}

function createHeadlessPluginPaths() {
  const home = homedir();
  const config = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(home, '.mica');
  return {
    home,
    config,
    plugins: join(config, 'plugins'),
  };
}
