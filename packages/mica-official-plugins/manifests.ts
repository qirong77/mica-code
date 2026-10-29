import { parsePluginManifest, type PluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import autoCompactManifest from '../../plugins/auto-compact/plugin.json';
import btwManifest from '../../plugins/btw/plugin.json';
import commitManifest from '../../plugins/commit/plugin.json';
import computerUseManifest from '../../plugins/computer-use/plugin.json';
import connectionsManifest from '../../plugins/connections/plugin.json';
import harnessReviewManifest from '../../plugins/harness-review/plugin.json';
import memoryManifest from '../../plugins/memory/plugin.json';
import mobileRelayManifest from '../../plugins/mobile-relay/plugin.json';
import scheduleManifest from '../../plugins/schedule/plugin.json';
import sessionRenameManifest from '../../plugins/session-rename/plugin.json';
import sessionNotesManifest from '../../plugins/session-notes/plugin.json';
import sessionCopyManifest from '../../plugins/session-copy/plugin.json';
import sessionTagsManifest from '../../plugins/session-tags/plugin.json';
import sidecarManifest from '../../plugins/sidecar/plugin.json';
import subagentManifest from '../../plugins/subagent/plugin.json';
import todoManifest from '../../plugins/todo/plugin.json';
import webSearchManifest from '../../plugins/web-search/plugin.json';

/**
 * 官方插件的清单目录。
 *
 * 清单来自仓库根 `plugins/<id>/plugin.json`（单一事实来源），入口在 `index.ts` 里静态登记，
 * 因此编译进单二进制后也能用。这里刻意只导入 JSON：配置页的数据层要列出官方插件，
 * 不应该顺带把插件实现（React / Ink）拖进进程。
 */
export const OFFICIAL_PLUGINS_DIR = 'plugins';

export const officialPluginManifests: PluginManifest[] = [
  readManifest(autoCompactManifest),
  readManifest(btwManifest),
  readManifest(commitManifest),
  readManifest(harnessReviewManifest),
  readManifest(memoryManifest),
  readManifest(webSearchManifest),
  readManifest(todoManifest),
  readManifest(sessionNotesManifest),
  readManifest(sessionCopyManifest),
  readManifest(sessionRenameManifest),
  readManifest(sessionTagsManifest),
  readManifest(sidecarManifest),
  readManifest(subagentManifest),
  readManifest(computerUseManifest),
  readManifest(connectionsManifest),
  readManifest(mobileRelayManifest),
  readManifest(scheduleManifest),
];

export const officialPluginIds = new Set(officialPluginManifests.map((manifest) => manifest.id));

function readManifest(entry: unknown): PluginManifest {
  const result = parsePluginManifest(entry);
  if (!result.ok) throw new Error(`官方插件清单无效：${result.error}`);
  return result.manifest;
}
