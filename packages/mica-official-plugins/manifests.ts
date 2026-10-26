import { parsePluginManifest, type PluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import sessionRenameManifest from '../../plugins/session-rename/plugin.json';
import todoManifest from '../../plugins/todo/plugin.json';

/**
 * 官方插件的清单目录。
 *
 * 清单来自仓库根 `plugins/<id>/plugin.json`（单一事实来源），入口在 `index.ts` 里静态登记，
 * 因此编译进单二进制后也能用。这里刻意只导入 JSON：配置页的数据层要列出官方插件，
 * 不应该顺带把插件实现（React / Ink）拖进进程。
 */
export const OFFICIAL_PLUGINS_DIR = 'plugins';

export const officialPluginManifests: PluginManifest[] = [readManifest(todoManifest), readManifest(sessionRenameManifest)];

export const officialPluginIds = new Set(officialPluginManifests.map((manifest) => manifest.id));

function readManifest(entry: unknown): PluginManifest {
  const result = parsePluginManifest(entry);
  if (!result.ok) throw new Error(`官方插件清单无效：${result.error}`);
  return result.manifest;
}
