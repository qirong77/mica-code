import React from 'react';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { Box, Text } from '@anthropic/ink';
import { ThemeProvider } from '../../../../packages/@anthropic/ink/src/theme/ThemeProvider.js';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { readActiveProviderConfig } from '@packages/mica-config/index.js';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import { micaPlugin, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { configureIterationRewrite, registerIterationRewrite } from '../agent/iterationRewrite.js';
import {
  normalizeUiState,
  TerminalAgentSessionManager,
  type TerminalAgentSession,
} from '../agents/terminalAgentSessions.js';
import {
  formatSubagentTaskDisplay,
  formatSubagentTaskNotification,
  SubagentTaskManager,
} from '../agents/SubagentTaskManager.js';
import { applySessionConfig, SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import { createPluginSubagentHost } from '../agents/PluginSubagentHost.js';
import { createPluginModels, recordPluginModelUsage } from '../plugins/pluginModels.js';
import { showPluginNotice } from '../plugins/commands/commandRuntimeServices.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { clearActiveContext, setActiveContext } from './activeContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';
import { finalizeInteractiveUi } from './finalizeInteractiveUi.js';
import setupFilePlugins from '@packages/mica-builtin-commands/startup/file-plugins.js';
import validateConfigPlugin from '@packages/mica-builtin-commands/startup/validate-config.js';
import setupModelEffortContext from '@packages/mica-builtin-commands/startup/model-effort-context/index.js';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private context: ApplicationContext | null = null;
  private stopPromise: Promise<void> | null = null;
  private subagentTasks: SubagentTaskManager | null = null;
  private pluginSubagents: ReturnType<typeof createPluginSubagentHost> | null = null;

  constructor(private readonly options: { sessionId?: string } = {}) {}

  get activeContext(): ApplicationContext | null {
    return this.context;
  }

  use(plugin: MicaPlugin): this {
    const plugins = this.context?.plugins;
    if (!plugins) {
      throw new Error('Application plugins are not ready. Call use() from the plugin registration phase.');
    }
    plugins.register(plugin);
    return this;
  }

  async start(): Promise<void> {
    const sessionStore = micaSession.createStore();
    let startupSession = this.options.sessionId ? sessionStore.load(this.options.sessionId) : null;
    const missingStartupSessionId = this.options.sessionId && !startupSession ? this.options.sessionId : null;
    // Switch before plugins/runtime start so AGENT.md, skills and tools resolve
    // against the resumed session's directory instead of the launch cwd.
    const startupCwdError = startupSession ? switchToSessionCwd(startupSession.cwd) : null;
    seedStartupModelDisplay(startupSession);
    this.renderInstance = await wrappedRender(
      React.createElement(ThemeProvider, { initialState: 'auto', children: React.createElement(micaUi.App) }),
      { exitOnCtrlC: false },
    );
    micaUi.terminalInput.setOnExitRequested((exitCode) => this.requestExit(exitCode));

    try {
      const pluginPaths = createPluginPaths();
      validateConfigPlugin({ paths: pluginPaths, logger: pluginLogger });
      setupModelEffortContext();
      if (startupSession) {
        const snapshot = applySessionConfig(startupSession.snapshot);
        startupSession = { ...startupSession, snapshot };
        void micaConfig.ensureModelRule(snapshot.model, undefined, { id: snapshot.providerId }).catch(() => undefined);
      } else {
        try {
          await ensureInitialModelSelection();
        } catch (modelError) {
          const msg = modelError instanceof Error ? modelError.message : String(modelError);
          micaUi.messageBar.addMessage({
            id: 'model-load-warning',
            text: `模型加载失败：${msg}；请使用 /model 配置可用的 provider`,
          });
        }
        const currentModel = micaConfig.get().model;
        if (currentModel)
          void micaConfig
            .ensureModelRule(currentModel, undefined, micaConfig.providerForModel(currentModel))
            .catch(() => undefined);
      }
      const hooks = new micaPlugin.HookRegistry();
      const agent = new AgentRuntime({}, hooks);
      const sessionController = new SessionController({ agent, store: sessionStore });
      const commands = new micaCommands.CommandRegistry();
      const services = new micaPlugin.ServiceContainer();
      const plugins = new micaPlugin.PluginManager();
      const agentSessions = new TerminalAgentSessionManager(hooks);
      let runtime!: LocalRuntimeController;
      const subagentTasks = new SubagentTaskManager({
        onTaskFinished: (task, owner) => {
          runtime.deliverSystemInput(owner, formatSubagentTaskNotification(task), formatSubagentTaskDisplay(task));
        },
      });
      runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services, subagentTasks);
      const uiBridge = new MicaUiRuntimeBridge(agent, runtime, agentSessions, subagentTasks);
      this.subagentTasks = subagentTasks;
      agentSessions.registerCurrent(agent, sessionController);
      // 子代理是插件能力面：`agent` 工具由插件注册，内核只提供创建/运行/记账/租约机制。
      const pluginSubagents = createPluginSubagentHost({
        defaultAgent: agent,
        taskManager: subagentTasks,
        // 旁问线程没有工具调用可以带 owner：它绑在用户当前看着的那条会话上。
        resolveCurrentAgent: () => resolvePluginSession(agentSessions, undefined)?.agent ?? agent,
        persistUsage: (owner) => {
          if (owner.isRunning) return;
          resolvePluginSession(agentSessions, owner)?.sessionController.saveCurrent({ allowEmpty: true });
        },
      });
      this.pluginSubagents = pluginSubagents;
      // 插件重写模型请求的那条链需要知道「这次请求属于哪条会话」，而 agent 本身不持有
      // 会话身份（一条会话可以被 fork、可以有多个 agent），所以由这一层回答。
      configureIterationRewrite({
        mode: 'session',
        resolveSessionId: (target) =>
          agentSessions.findByAgent(target)?.sessionController.getCurrentSessionId() ?? null,
        onError: reportPluginIterationError,
      });

      this.context = {
        agent,
        sessionController,
        commands,
        hooks,
        services,
        events: runtime.events,
        plugins,
        runtime,
        uiBridge,
        agentSessions,
        subagentTasks,
      };

      setActiveContext(this.context);

      useBuiltinPlugins(this, agent, sessionController);
      const filePlugins = await setupFilePlugins({
        paths: pluginPaths,
        plugins,
        loadFilePlugins: micaPlugin.loadFilePlugins,
        logger: pluginLogger,
      });

      const setupReport = await plugins.setupAll({
        paths: pluginPaths,
        services,
        hooks,
        commands,
        events: runtime.events,
        session: {
          describe: (owner) => {
            const session = resolvePluginSession(agentSessions, owner);
            if (!session) return null;
            const parentSessionId = session.sessionController.getParentSessionId();
            return {
              id: session.id,
              title: session.titleOverride ?? session.sessionController.getCurrentDisplayTitle(),
              titleSource: session.sessionController.getCurrentTitleSource(),
              cwd: process.cwd(),
              role: session.agent.role,
              ...(parentSessionId ? { parentSessionId } : {}),
            };
          },
          // 与 app-server 同一个口径：用户眼前的那份对话（落盘快照），provider history 在
          // compact 后只是摘要，导出会话的插件据此拼出来会缺正文。
          messages: (owner) => resolvePluginSession(agentSessions, owner)?.sessionController.getConversationMessages() ?? [],
          rename: (title, options) => {
            const session = resolvePluginSession(agentSessions, options?.owner);
            if (!session) return false;
            if (!session.sessionController.renameCurrent(title, { source: options?.source ?? 'auto' })) return false;
            agentSessions.renameAgent(session.agent, title);
            uiBridge.syncAgentStatusItems();
            return true;
          },
        },
        // 插件状态跟着「当前 agent」走：多 agent 会话下 owner 决定写哪一条，
        // 不传 owner 就是当前会话。
        sessionStateFor: (pluginId) => ({
          get: () => resolvePluginSession(agentSessions, undefined)?.agent.getPluginState(pluginId),
          // 没有会话就抛出：静默丢弃写入会让插件以为状态存住了，实际下一轮读回 undefined。
          set: (value) => {
            const agent = resolvePluginSession(agentSessions, undefined)?.agent;
            if (!agent) throw new Error(`session state unavailable for ${pluginId}`);
            agent.setPluginState(pluginId, value);
          },
          clear: () => resolvePluginSession(agentSessions, undefined)?.agent.clearPluginState(pluginId),
        }),
        // 会话级设置覆盖与插件状态一样跟着「当前 agent」走；没有会话时抛出，
        // 免得用户以为改动生效了、实际没落进任何快照。
        sessionSettingsFor: (pluginId) => ({
          read: () => resolvePluginSession(agentSessions, undefined)?.agent.getPluginSessionSettings(pluginId),
          write: (value) => {
            const agent = resolvePluginSession(agentSessions, undefined)?.agent;
            if (!agent) throw new Error(`session settings unavailable for ${pluginId}`);
            agent.setPluginSessionSettings(pluginId, value);
          },
        }),
        promptSections: agent.promptSections,
        agentRegistry: {
          mode: 'session',
          onIterationRewrite: (pluginId, handler) => registerIterationRewrite(pluginId, handler),
        },
        subagentsFor: (pluginId) => pluginSubagents.forPlugin(pluginId),
        // 插件自己的模型请求（起标题、写 commit message、整理记忆）由宿主代发：
        // 记账只有宿主做得到，请求实现也只该有一份。
        pluginModels: createPluginModels({
          record: (entry) => {
            const session = resolvePluginSession(agentSessions, undefined);
            recordPluginModelUsage(entry, {
              agent: session?.agent,
              save: () => session?.sessionController.saveCurrent({ allowEmpty: true }),
            });
          },
          // 「跟随主配置」跟的是这条会话正在用的 provider：会话切到别的服务商之后，
          // 插件请求跟着走，而不是打回配置页里的全局默认。
          resolveMainProvider: (model) => {
            // 插件点名了模型：让 provider 跟着模型前缀走；否则跟会话正在用的那一个。
            if (model) return readActiveProviderConfig({ model });
            const snapshot = resolvePluginSession(agentSessions, undefined)?.agent.getSnapshot();
            return readActiveProviderConfig(
              snapshot ? { providerId: snapshot.providerId, model: snapshot.model } : {},
            );
          },
        }),
        runtime: {
          submit: (text, options) => runtime.submit(text, options),
          queue: {
            isBusy: (owner) => runtime.isAgentBusy(owner as AgentRuntime),
            enqueue: (owner, input) => runtime.enqueueForAgent(owner as AgentRuntime, input),
            dequeue: (owner) => runtime.dequeueForAgent(owner as AgentRuntime),
            list: (owner) => runtime.listQueueForAgent(owner as AgentRuntime),
          },
        },
        tools: {
          register: (tool, options = {}) => {
            const registered = micaTools.registerRuntime(tool, { primaryAgentOnly: options.primaryAgentOnly });
            const unregisterIcon = options.icon ? micaUi.registerToolIcon(registered.name, options.icon) : null;
            return {
              dispose: () => {
                micaTools.unregisterRuntime(registered);
                unregisterIcon?.();
              },
            };
          },
        },
        ui: {
          submit: (text, options) => micaUi.terminalInput.submit(text, options),
          showMessage: (text, ttl = 3000) => showPluginMessage(text, ttl),
          notice: (content, options) => showPluginNotice(content, options ?? {}),
          components: {
            createElement: React.createElement,
            Dialog: micaUi.Dialog,
            KeyHints: micaUi.KeyHints,
            Box,
            Text,
          },
          panels: {
            upsert: micaUi.panels.upsertPluginUI,
            remove: micaUi.panels.removePluginUI,
          },
          status: {
            upsert: micaUi.panels.upsertPluginStatusItem,
            remove: micaUi.panels.removePluginStatusItem,
          },
          input: {
            getText: () => micaUi.terminalInput.text.get(),
            registerFileMentionProvider: (provider) => micaUi.terminalInput.registerFileMentionProvider(provider),
          },
          useScheduleState: micaUi.useScheduleState,
          theme: micaUi.theme,
        },
        git: {
          text: gitText,
          formatError: formatExecError,
        },
        logger: pluginLogger,
      });
      micaPlugin.writePluginStatus({
        pluginsDir: pluginPaths.plugins,
        configDir: pluginPaths.config,
        host: 'tui',
        filePlugins,
        setupReport,
      });
      syncCommandDropdown(commands, runtime);

      const resumed = startupSession ? sessionController.resumeLoaded(startupSession) : null;
      if (resumed?.ok) {
        const currentSession = agentSessions.current();
        currentSession.uiState = normalizeUiState({
          ...currentSession.uiState,
          conversationMessages: micaUi.conversation.messages.get(),
        });
      }
      uiBridge.start();
      await runtime.start();

      if (resumed?.ok) {
        showPluginMessage(`Resumed: ${resumed.session.title}`, 4000);
      } else if (missingStartupSessionId) {
        showPluginMessage(`Session not found: ${missingStartupSessionId}; started a new session`, 7000);
      }
      if (startupCwdError) showPluginMessage(startupCwdError, 7000);

      void micaConfig.loadMissingProviderModels().then(() => {
        if (!agent.isRunning) {
          agent.reloadConfig(false);
          syncModelDisplay(agent);
        }
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
      // Apple Terminal sends the same byte (\r) for Shift+Enter and Enter and
      // has no kitty keyboard protocol support, so Shift+Enter/Cmd+Backspace
      // shortcuts can never reach the app there. Surface the working
      // alternatives once so users don't hunt for the broken bindings.
      if (process.env.TERM_PROGRAM === 'Apple_Terminal') {
        showPluginMessage(
          'Apple Terminal 不支持 Shift+Enter 换行：请用 Option+Enter（终端设置需开启“将 Option 用作 Meta 键”）或 Ctrl+J；Cmd+Backspace 删除行不可用，可用 Ctrl+U 删除到行首',
          9000,
        );
      }
    } catch (error) {
      micaUi.terminalInput.setPlaceholder('启动失败：修复配置后重新运行 mica，按 Ctrl+C 退出');
      reportRuntimeError(error, '启动失败');
      micaUi.messageBar.addMessage({
        id: 'startup-error-hint',
        text: '启动失败：请根据错误提示修复配置文件，然后重新运行 mica；按 Ctrl+C 退出',
      });
      this.pluginSubagents?.disposeAll();
      this.pluginSubagents = null;
      const failedContext = this.context;
      failedContext?.uiBridge.stop();
      const runtimeStop = failedContext?.runtime.stop();
      const subagentTasks = this.subagentTasks;
      this.subagentTasks = null;
      await subagentTasks?.stop();
      await runtimeStop;
      await failedContext?.plugins.disposeAll();
      failedContext?.agentSessions.stop();
      if (failedContext) clearActiveContext(failedContext);
      this.context = null;
      process.exitCode = 1;
    }
  }

  async waitUntilExit(): Promise<void> {
    await this.renderInstance?.waitUntilExit();
  }

  async requestExit(exitCode = 0): Promise<void> {
    process.exitCode = exitCode;
    const sessionController = this.context?.agentSessions.current().sessionController;
    const saved = sessionController?.saveCurrent() ?? false;
    const sessionId = saved ? sessionController?.getCurrentSessionId() : undefined;
    await this.stop();
    finalizeInteractiveUi(this.renderInstance);
    if (sessionId && process.stdout.isTTY) {
      writeSync(1, `\nResume this session with:\n mica --resume ${sessionId}\n\n`);
    }
    process.exit(exitCode);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    micaUi.terminalInput.setOnExitRequested(null);
    this.context?.uiBridge.stop();
    const runtimeStop = this.context?.runtime.stop();
    const subagentTasks = this.subagentTasks;
    this.subagentTasks = null;
    this.pluginSubagents?.disposeAll();
    this.pluginSubagents = null;
    await subagentTasks?.stop();
    await terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 });
    await runtimeStop;
    await this.context?.plugins.disposeAll();
    this.context?.agentSessions.stop();
    if (this.context) clearActiveContext(this.context);
    this.context = null;
  }
}

function seedStartupModelDisplay(session: PersistedSession | null): void {
  const config = micaConfig.get();
  const model = session?.snapshot.model || config.model;
  const providerId = session?.snapshot.providerId ?? config.provider;
  const provider = config.providers.find((item) => item.id === providerId);
  micaUi.panels.modelDisplay.name.set(model || '-');
  micaUi.panels.modelDisplay.effort.set(
    !model ? '-' : provider?.supportsEffort === false ? 'none' : (session?.snapshot.effort ?? config.effort ?? '-'),
  );
  micaUi.panels.modelDisplay.contextWindowSize.set(
    session && model ? micaConfig.getModelRule(model, provider).contextSize : config.contextWindowSize,
  );
  micaUi.terminalInput.role.set(session?.snapshot.role ?? 'default');
}

function switchToSessionCwd(cwd: string | undefined): string | null {
  if (!cwd || cwd === process.cwd()) return null;
  try {
    process.chdir(cwd);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `无法切换到会话工作目录 ${cwd}：${message}`;
  }
}

function syncCommandDropdown(commands: CommandRegistry, runtime: LocalRuntimeController): void {
  micaUi.dropdown.setQuickCommands(
    commands.list().map((command) => ({
      name: command.name,
      description: command.description ?? '',
      completionItems: command.completionItems,
      action: (arg?: string) => {
        const text = `/${command.name}${arg ? ` ${arg}` : ''}`;
        void runtime.submit(text, { source: 'command' });
      },
    })),
  );
}

async function ensureInitialModelSelection(): Promise<void> {
  const config = micaConfig.get();
  if (config.model) return;

  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider?.get_model_url) return;

  await micaConfig.loadProviderModels(provider.id);
}

function showPluginMessage(text: string, ttl: number): void {
  const id = `plugin-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUi.messageBar.addMessage({ id, text });
  setTimeout(() => micaUi.messageBar.removeMessage(id), ttl);
}

function createPluginPaths() {
  const home = homedir();
  const config = resolveMicaHome();
  return {
    home,
    config,
    plugins: join(config, 'plugins'),
  };
}

/**
 * 把 `turn:after` 事件里的 owner 解析成具体会话：不给 owner 就是当前会话。
 * 插件是按「产生这个 turn 的 agent」操作的，多 agent 场景下不能默认取当前那一条。
 */
function resolvePluginSession(sessions: TerminalAgentSessionManager, owner: unknown): TerminalAgentSession | undefined {
  if (owner) {
    const matched = sessions.findByAgent(owner as AgentRuntime);
    if (matched) return matched;
  }
  return sessions.current();
}

const pluginLogger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * 模型请求重写失败：插件自己的策略算错了，不该让正在跑的 turn 挂掉，但也不能无声。
 * 与 hook 失败走同一条去向——插件日志 + 健康状态，用户能在配置页看到。
 */
function reportPluginIterationError(error: unknown, pluginId: string): void {
  const message = error instanceof Error ? error.message : String(error);
  micaPlugin.createPluginLogger(pluginId, pluginLogger).error('plugin:iteration-rewrite-failed', { error: message });
  micaPlugin.writePluginHealth(pluginId, { level: 'error', message: `模型请求重写失败：${message}` });
}
