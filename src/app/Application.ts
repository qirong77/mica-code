import React from 'react';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type MicaPlugin } from '@packages/mica-plugin/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { SessionController } from '../session/SessionController.js';
import { reportRuntimeError, syncModelDisplay } from '../runtime/uiBridge.js';
import { useBuiltinPlugins } from './builtinPlugins.js';
import type { ApplicationContext } from './ApplicationContext.js';
import { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { MicaUiRuntimeBridge } from './adapters/MicaUiRuntimeBridge.js';

export class Application {
  private renderInstance: Awaited<ReturnType<typeof wrappedRender>> | null = null;
  private agentRegistry: AgentRegistry | null = null;
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
      const agent = new AgentRuntime();
      const sessionController = new SessionController(agent);
      const commands = new micaCommands.CommandRegistry();
      const hooks = new micaPlugin.HookRegistry();
      const services = new micaPlugin.ServiceContainer();
      const plugins = new micaPlugin.PluginManager();
      const runtime = new LocalRuntimeController(agent, sessionController, commands, hooks, services);
      const uiBridge = new MicaUiRuntimeBridge(agent, runtime);

      this.agentRegistry = new AgentRegistry(agent);
      this.agentRegistry.start();

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
        agentRegistry: this.agentRegistry,
      };

      setActiveApplication(this);

      useBuiltinPlugins(this, agent, sessionController, this.agentRegistry, runtime);

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
      await runtime.start();

      void micaConfig.loadMissingProviderModels().then(() => {
        agent.reloadConfig(false);
        syncModelDisplay(agent);
      });

      micaUi.terminalInput.setPlaceholder('Type a message to start a conversation');
      micaLogger.logRuntime('runtime', 'application:start');
    } catch (error) {
      micaUi.terminalInput.setPlaceholder('Fix the startup error and restart Mica Code');
      reportRuntimeError(error, '启动失败');
      this.agentRegistry?.stop();
      this.agentRegistry = null;
      await this.context?.plugins.disposeAll();
      this.context = null;
      this.renderInstance?.unmount();
    }
  }

  async waitUntilExit(): Promise<void> {
    await this.renderInstance?.waitUntilExit();
  }

  async stop(): Promise<void> {
    await this.context?.runtime.stop();
    await this.context?.plugins.disposeAll();
    this.agentRegistry?.stop();
    this.agentRegistry = null;
    if (activeApplication === this) {
      activeApplication = null;
    }
  }
}

function toLogData(data: unknown): Record<string, unknown> | undefined {
  if (data == null) return undefined;
  if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { value: data };
}

let activeApplication: Application | null = null;

export function setActiveApplication(app: Application): void {
  activeApplication = app;
}

export function getActiveApplication(): Application | null {
  return activeApplication;
}
