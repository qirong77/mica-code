import React from 'react';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Box, Text } from '@anthropic/ink';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import { micaPlugin, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { TerminalAgentSessionManager } from '../agents/terminalAgentSessions.js';
import {
  formatSubagentTaskDisplay,
  formatSubagentTaskNotification,
  SubagentTaskManager,
} from '../agents/SubagentTaskManager.js';
import { SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { clearActiveContext, setActiveContext } from './activeContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';
import setupFilePlugins, { writeFilePluginStatus } from '../../buildin-plugins/file-plugins.mjs';
import validateConfigPlugin from '../../buildin-plugins/validate-config.mjs';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private context: ApplicationContext | null = null;
  private stopPromise: Promise<void> | null = null;
  private subagentTasks: SubagentTaskManager | null = null;

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
    this.renderInstance = await wrappedRender(React.createElement(micaUi.App), {
      exitOnCtrlC: false,
    });

    try {
      const pluginPaths = createPluginPaths();
      validateConfigPlugin({ paths: pluginPaths, logger: pluginLogger });
      setupModelEffortContext();
      await ensureInitialModelSelection();
      const agent = new AgentRuntime();
      const sessionController = new SessionController(agent);
      const commands = new micaCommands.CommandRegistry();
      const hooks = new micaPlugin.HookRegistry();
      const services = new micaPlugin.ServiceContainer();
      const plugins = new micaPlugin.PluginManager();
      const agentSessions = new TerminalAgentSessionManager();
      const runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services);
      const subagentTasks = new SubagentTaskManager({
        onTaskFinished: (task, owner) => {
          runtime.deliverSystemInput(owner, formatSubagentTaskNotification(task), formatSubagentTaskDisplay(task));
        },
      });
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
        runtime: {
          submit: (text, options) => runtime.submit(text, options),
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
          input: {
            getText: () => micaUi.terminalInput.text.get(),
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

      uiBridge.start();
      await runtime.start();

      void micaConfig.loadMissingProviderModels().then(() => {
        if (!agent.isRunning) {
          agent.reloadConfig(false);
          syncModelDisplay(agent);
        }
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
      micaUi.terminalInput.setOnExitRequested(() => {
        void this.requestExit();
      });
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
    await this.stop();
    this.renderInstance?.unmount();
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
