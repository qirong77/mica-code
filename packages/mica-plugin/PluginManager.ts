import type { Disposable } from '@packages/mica-common/index.js';
import type { MicaPlugin } from './Plugin.js';
import type { PluginContext } from './PluginContext.js';
import { createPluginLogger } from './PluginLog.js';
import { createPluginSettingsStore } from './PluginSettings.js';

export type PluginSetupReport = {
  loaded: string[];
  failed: { pluginId: string; error: unknown }[];
};

/**
 * 每个插件在 setup 时拿到的东西，去掉三项「按插件生成」的：
 *
 * - `pluginId` / `onDispose`：生命周期绑定，只由 PluginManager 决定；
 * - `logger`：包装成带插件 id 的文件日志，写进 `os.tmpdir()/mica-logs/`；
 * - `settings`：按插件清单里的 `settings` 声明读取，路径跟着 `paths.config` 走。
 *
 * host 仍然可以传自己的 `logger`，它会作为落盘之外的转发目标（TUI 静默、headless 写 stderr）。
 */
export type PluginBaseContext = Omit<PluginContext, 'pluginId' | 'onDispose' | 'logger' | 'settings'> & {
  logger?: PluginContext['logger'];
};

export class PluginManager {
  private readonly plugins = new Map<string, MicaPlugin>();
  private readonly disposables: Disposable[] = [];

  register(plugin: MicaPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  async setupAll(baseContext: PluginBaseContext): Promise<PluginSetupReport> {
    const report: PluginSetupReport = { loaded: [], failed: [] };

    for (const plugin of this.sortedPlugins()) {
      const localDisposables: Disposable[] = [];
      const logger = createPluginLogger(plugin.id, baseContext.logger);
      const ctx: PluginContext = {
        ...baseContext,
        pluginId: plugin.id,
        logger,
        settings: createPluginSettingsStore(plugin.id, plugin.manifest?.settings ?? [], {
          configDir: baseContext.paths?.config,
        }),
        onDispose: (dispose) => localDisposables.push({ dispose }),
      };

      try {
        const disposable = await plugin.setup(ctx);
        if (disposable) localDisposables.push(disposable);
        this.disposables.push(...localDisposables.reverse());
        report.loaded.push(plugin.id);
      } catch (error) {
        for (const disposable of localDisposables.splice(0).reverse()) {
          try {
            await disposable.dispose();
          } catch {
            // Preserve the setup error as the canonical plugin failure.
          }
        }
        report.failed.push({ pluginId: plugin.id, error });
        logger.error('plugin:setup-failed', { error: errorMessage(error) });
        if (plugin.required) throw error;
      }
    }

    return report;
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  async disposeAll(): Promise<void> {
    for (const disposable of this.disposables.splice(0).reverse()) {
      await disposable.dispose();
    }
  }

  private sortedPlugins(): MicaPlugin[] {
    return [...this.plugins.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
