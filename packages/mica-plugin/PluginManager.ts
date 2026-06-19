import type { Disposable } from '@packages/mica-common/index.js';
import type { MicaPlugin } from './Plugin.js';
import type { PluginContext } from './PluginContext.js';

export type PluginSetupReport = {
  loaded: string[];
  failed: { pluginId: string; error: unknown }[];
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

  async setupAll(baseContext: Omit<PluginContext, 'pluginId' | 'onDispose'>): Promise<PluginSetupReport> {
    const report: PluginSetupReport = { loaded: [], failed: [] };

    for (const plugin of this.sortedPlugins()) {
      const localDisposables: Disposable[] = [];
      const ctx: PluginContext = {
        ...baseContext,
        pluginId: plugin.id,
        onDispose: (dispose) => localDisposables.push({ dispose }),
      };

      try {
        const disposable = await plugin.setup(ctx);
        if (disposable) localDisposables.push(disposable);
        this.disposables.push(...localDisposables.reverse());
        report.loaded.push(plugin.id);
      } catch (error) {
        report.failed.push({ pluginId: plugin.id, error });
        if (plugin.required) throw error;
      }
    }

    return report;
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
