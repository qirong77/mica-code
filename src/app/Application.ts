import React from 'react';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { TerminalAgentSessionManager } from '../agents/terminalAgentSessions.js';
import { SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
import { syncStartupBanner } from '../runtime/startupBanner.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { clearActiveContext, setActiveContext } from './activeContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private context: ApplicationContext | null = null;

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
      micaConfig.assertValid();
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

      await plugins.setupAll({
        services,
        hooks,
        commands,
        events: runtime.events,
        logger: {
          info: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data)),
          warn: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data), 'warn'),
          error: (event, data) => micaLogger.logRuntime('plugin', event, toLogData(data), 'error'),
        },
      });

      uiBridge.start();
      syncStartupBanner(agent);
      await runtime.start();
      syncStartupBanner(agent);

      void micaConfig.loadMissingProviderModels().then(() => {
        if (!agent.isRunning) {
          agent.reloadConfig(false);
          syncModelDisplay(agent);
          syncStartupBanner(agent);
        }
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
      micaLogger.logRuntime('runtime', 'application:start');
    } catch (error) {
      micaUi.terminalInput.setPlaceholder('启动失败：修复配置后重新运行 mica，按 Ctrl+C 退出');
      reportRuntimeError(error, '启动失败');
      micaUi.messageBar.addMessage({
        id: 'startup-error-hint',
        text: '启动失败：请根据错误提示修复配置文件，然后重新运行 mica；按 Ctrl+C 退出',
      });
      this.context?.agentSessions.stop();
      await this.context?.plugins.disposeAll();
      this.context = null;
      process.exitCode = 1;
    }
  }

  async waitUntilExit(): Promise<void> {
    await this.renderInstance?.waitUntilExit();
  }

  async stop(): Promise<void> {
    this.context?.uiBridge.stop();
    await this.context?.runtime.stop();
    await this.context?.plugins.disposeAll();
    this.context?.agentSessions.stop();
    if (this.context) clearActiveContext(this.context);
  }
}

function toLogData(data: unknown): Record<string, unknown> | undefined {
  if (data == null) return undefined;
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { value: data };
}
