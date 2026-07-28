import React from 'react';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Box, Text } from '@anthropic/ink';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import { micaPlugin, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { normalizeUiState, TerminalAgentSessionManager } from '../agents/terminalAgentSessions.js';
import {
  formatSubagentTaskDisplay,
  formatSubagentTaskNotification,
  SubagentTaskManager,
} from '../agents/SubagentTaskManager.js';
import { applySessionConfig, SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { clearActiveContext, setActiveContext } from './activeContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';
import { finalizeInteractiveUi } from './finalizeInteractiveUi.js';
import setupFilePlugins, { writeFilePluginStatus } from '../../buildin-plugins/file-plugins.mjs';
import validateConfigPlugin from '../../buildin-plugins/validate-config.mjs';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private context: ApplicationContext | null = null;
  private stopPromise: Promise<void> | null = null;
  private subagentTasks: SubagentTaskManager | null = null;

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
    seedStartupModelDisplay(startupSession);
    this.renderInstance = await wrappedRender(React.createElement(micaUi.App), {
      exitOnCtrlC: false,
    });
    micaUi.terminalInput.setOnExitRequested((exitCode) => this.requestExit(exitCode));

    try {
      const pluginPaths = createPluginPaths();
      validateConfigPlugin({ paths: pluginPaths, logger: pluginLogger });
      setupModelEffortContext();
      if (startupSession) {
        const snapshot = applySessionConfig(startupSession.snapshot);
        startupSession = { ...startupSession, snapshot };
        await micaConfig.ensureModelRule(snapshot.model);
      } else {
        await ensureInitialModelSelection();
        await micaConfig.ensureModelRule(micaConfig.get().model);
      }
      const agent = new AgentRuntime();
      const sessionController = new SessionController({ agent, store: sessionStore });
      const commands = new micaCommands.CommandRegistry();
      const hooks = new micaPlugin.HookRegistry();
      const services = new micaPlugin.ServiceContainer();
      const plugins = new micaPlugin.PluginManager();
      const agentSessions = new TerminalAgentSessionManager();
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
      micaTools.registerRuntime(new ToolAgent(agent, subagentTasks));

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

      useBuiltinPlugins(this, agent, sessionController, agentSessions, () => uiBridge.syncAgentStatusItems());
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
            micaTools.registerRuntime(tool, { primaryAgentOnly: options.primaryAgentOnly });
            const unregisterIcon = options.icon ? micaUi.registerToolIcon(tool.name, options.icon) : null;
            return {
              dispose: () => {
                micaTools.unregisterRuntime(tool);
                unregisterIcon?.();
              },
            };
          },
        },
        ui: {
          submit: (text, options) => micaUi.terminalInput.submit(text, options),
          showMessage: (text, ttl = 3000) => showPluginMessage(text, ttl),
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
      writeFilePluginStatus({ paths: pluginPaths, logger: pluginLogger }, filePlugins, setupReport);
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

      void micaConfig.loadMissingProviderModels().then(() => {
        if (!agent.isRunning) {
          agent.reloadConfig(false);
          syncModelDisplay(agent);
        }
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
    } catch (error) {
      micaUi.terminalInput.setPlaceholder('启动失败：修复配置后重新运行 mica，按 Ctrl+C 退出');
      reportRuntimeError(error, '启动失败');
      micaUi.messageBar.addMessage({
        id: 'startup-error-hint',
        text: '启动失败：请根据错误提示修复配置文件，然后重新运行 mica；按 Ctrl+C 退出',
      });
      micaTools.unregisterRuntime('Agent');
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
    await subagentTasks?.stop();
    await terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 });
    await runtimeStop;
    await this.context?.plugins.disposeAll();
    micaTools.unregisterRuntime('Agent');
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
    session && model ? micaConfig.getModelRule(model).contextSize : config.contextWindowSize,
  );
  micaUi.terminalInput.role.set(session?.snapshot.role ?? 'default');
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
  const config = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(home, '.mica');
  return {
    home,
    config,
    plugins: join(config, 'plugins'),
  };
}

const pluginLogger = {
  info() {},
  warn() {},
  error() {},
};
