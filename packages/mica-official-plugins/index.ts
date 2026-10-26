import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import sessionRenameSetup from '../../plugins/session-rename/index.js';
import todoSetup from '../../plugins/todo/index.js';
import { officialPluginManifests } from './manifests.js';

export { OFFICIAL_PLUGINS_DIR, officialPluginIds, officialPluginManifests } from './manifests.js';

/**
 * 官方插件（入口 + 清单）的静态登记表。
 *
 * 只有真正要跑插件的地方（CLI 交互启动、headless）才导入这个入口：它把插件的实现一起拉
 * 进来。只想列清单的地方用 `./manifests.js`。
 */
const officialSetups: Record<string, MicaPlugin['setup']> = {
  todo: todoSetup,
  'session-rename': sessionRenameSetup,
};

export const officialPlugins: MicaPlugin[] = officialPluginManifests.map((manifest) => {
  const setup = officialSetups[manifest.id];
  if (!setup) throw new Error(`官方插件缺少入口登记：${manifest.id}`);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    priority: manifest.priority,
    dependencies: manifest.dependencies.length > 0 ? manifest.dependencies : undefined,
    required: manifest.required,
    manifest,
    setup,
  };
});
