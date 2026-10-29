import { loadFilePlugins, type FilePluginLoadResult, type FilePluginLoaderOptions } from './FilePluginLoader.js';
import { readDisabledPluginIds } from './PluginState.js';
import type { PluginManager } from './PluginManager.js';

/**
 * 把 `$MICA_HOME/plugins` 下的用户插件装进 manager。
 *
 * 常驻宿主（TUI、`mica app-server`）都要做同一件事，所以收在这里，宿主只决定「要不要
 * 装」。装配结论写盘走 `writePluginStatus()`（`PluginStatus.ts`）：那边同时负责官方插件
 * 与「这份记录来自哪个宿主」。
 */

/**
 * 加载并注册用户插件。
 *
 * 停用发生在 import 之前：停用的插件连代码都不执行，避免它在 setup 之外留下副作用。
 * 同一 id 已经注册过（例如官方插件与用户插件撞名）时保留先注册的那个。
 */
export async function loadUserPlugins(
  manager: PluginManager,
  options: { pluginsDir: string; disabled?: string[] } & FilePluginLoaderOptions,
): Promise<FilePluginLoadResult> {
  const loaded = await loadFilePlugins({
    pluginsDir: options.pluginsDir,
    disabled: options.disabled ?? readDisabledPluginIds(),
    logger: options.logger,
  });
  for (const plugin of loaded.plugins) {
    if (manager.has(plugin.id)) continue;
    manager.register(plugin);
  }
  return loaded;
}
