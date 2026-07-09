import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Box, Text } from '@anthropic/ink';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';
import {
  micaPlugin,
  type FilePluginLoadResult,
  type MicaPlugin,
  type PluginManager,
  type PluginSetupReport,
} from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, terminateCurrentBackgroundTasks } from '@packages/mica-tools/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { TerminalAgentSessionManager } from '../agents/terminalAgentSessions.js';
import { SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
// import { syncStartupBanner } from '../runtime/startupBanner.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import { ToolAgent } from '../tools/ToolAgent.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { clearActiveContext, setActiveContext } from './activeContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private context: ApplicationContext | null = null;
  private stopPromise: Promise<void> | null = null;

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
    micaRuntime.memoryUsageMonitor.start();
    this.renderInstance = await wrappedRender(React.createElement(micaUi.App), {
      exitOnCtrlC: false,
    });

    try {
      micaConfig.assertValid();
      void micaConfig.refreshRemoteModelRules();
      await ensureInitialModelSelection();
      const agent = new AgentRuntime();
      const sessionController = new SessionController(agent);
      const commands = new micaCommands.CommandRegistry();
      const hooks = new micaPlugin.HookRegistry();
      const services = new micaPlugin.ServiceContainer();
      const plugins = new micaPlugin.PluginManager();
      const agentSessions = new TerminalAgentSessionManager();
      const runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services);
      const uiBridge = new MicaUiRuntimeBridge(agent, runtime, agentSessions);
      agentSessions.registerCurrent(agent, sessionController);
      micaTools.registerRuntime(new ToolAgent(agent));

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
      };

      setActiveContext(this.context);

      useBuiltinPlugins(this, agent, sessionController);
      const filePlugins = await this.useFilePlugins(plugins);

      const setupReport = await plugins.setupAll({
        paths: createPluginPaths(),
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
        memory: {
          capture: (label) => micaRuntime.memoryUsageMonitor.capture(label),
          getSnapshots: () => micaRuntime.memoryUsageMonitor.getSnapshots(),
          snapshots: micaRuntime.memoryUsageMonitor.snapshots,
          isRunning: () => micaRuntime.memoryUsageMonitor.isRunning(),
          getStartedAt: () => micaRuntime.memoryUsageMonitor.getStartedAt(),
          getIntervalMs: () => micaRuntime.memoryUsageMonitor.getIntervalMs(),
          getMaxSnapshots: () => micaRuntime.memoryUsageMonitor.getMaxSnapshots(),
        },
        logger: {
          info: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data)),
          warn: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data), 'warn'),
          error: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data), 'error'),
        },
      });
      writePluginStatus(filePlugins, setupReport);
      syncCommandDropdown(commands, runtime);

      uiBridge.start();
      // syncStartupBanner(agent);
      await runtime.start();
      // syncStartupBanner(agent);

      void micaConfig.loadMissingProviderModels().then(() => {
        if (!agent.isRunning) {
          agent.reloadConfig(false);
          syncModelDisplay(agent);
          // syncStartupBanner(agent);
        }
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
      micaUi.terminalInput.setOnExitRequested(() => {
        void this.requestExit();
      });
      micaLogger.logRuntime('runtime', 'application:start');
    } catch (error) {
      micaUi.terminalInput.setPlaceholder('启动失败：修复配置后重新运行 mica，按 Ctrl+C 退出');
      reportRuntimeError(error, '启动失败');
      micaUi.messageBar.addMessage({
        id: 'startup-error-hint',
        text: '启动失败：请根据错误提示修复配置文件，然后重新运行 mica；按 Ctrl+C 退出',
      });
      micaTools.unregisterRuntime('Agent');
      this.context?.agentSessions.stop();
      await this.context?.plugins.disposeAll();
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
    if (micaRuntime.memoryUsageMonitor.isRunning()) {
      micaRuntime.memoryUsageMonitor.capture('application:stop');
      micaRuntime.memoryUsageMonitor.stop();
    }
    micaUi.terminalInput.setOnExitRequested(null);
    this.context?.uiBridge.stop();
    await terminateCurrentBackgroundTasks({ signal: 'SIGTERM', forceAfterMs: 1500 });
    await this.context?.runtime.stop();
    await this.context?.plugins.disposeAll();
    micaTools.unregisterRuntime('Agent');
    this.context?.agentSessions.stop();
    if (this.context) clearActiveContext(this.context);
    this.context = null;
  }

  private async useFilePlugins(plugins: PluginManager): Promise<FilePluginLoadResult> {
    const loaded = await micaPlugin.loadFilePlugins({
      pluginsDir: createPluginPaths().plugins,
      logger: {
        warn: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data), 'warn'),
      },
    });

    for (const plugin of loaded.plugins) {
      if (plugins.has(plugin.id)) {
        micaLogger.logRuntime('plugin', 'file-plugin:duplicate', { pluginId: plugin.id }, 'warn');
        continue;
      }
      plugins.register(plugin);
    }
    return loaded;
  }
}

function syncCommandDropdown(commands: CommandRegistry, runtime: LocalRuntimeController): void {
  micaUi.dropdown.setQuickCommands(
    commands.list().map((command) => ({
      name: command.name,
      description: command.description ?? '',
      hidden: command.hidden,
      hiddenMenuParent: command.hiddenMenuParent,
      hiddenMenuItems: command.hiddenMenuItems,
      action: (arg?: string) => {
        const text = `/${command.name}${arg ? ` ${arg}` : ''}`;
        void runtime.submit(text, { source: 'command' });
      },
    })),
  );
}

function writePluginStatus(filePlugins: FilePluginLoadResult, setupReport: PluginSetupReport): void {
  const paths = createPluginPaths();
  const setupFailed = new Map(setupReport.failed.map((item) => [item.pluginId, formatError(item.error)]));
  const loadedIds = new Set(setupReport.loaded);
  const status = {
    root: paths.plugins,
    updatedAt: new Date().toISOString(),
    plugins: filePlugins.loaded.map((plugin) => ({
      id: plugin.pluginId,
      file: plugin.file,
      status: setupFailed.has(plugin.pluginId) ? 'failed' : loadedIds.has(plugin.pluginId) ? 'loaded' : 'registered',
      error: setupFailed.get(plugin.pluginId),
    })),
    loadFailed: filePlugins.failed.map((item) => ({ file: item.file, status: 'failed', error: formatError(item.error) })),
  };
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(join(paths.config, 'plugin-status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf-8');
}

async function ensureInitialModelSelection(): Promise<void> {
  const config = micaConfig.get();
  if (config.model) return;

  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider?.get_model_url) return;

  await micaConfig.loadProviderModels(provider.id);
}

function toLogData(data: unknown): Record<string, unknown> | undefined {
  if (data == null) return undefined;
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { value: data };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
