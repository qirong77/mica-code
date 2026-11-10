import type { MicaPlugin } from '@packages/mica-plugin/index.js';
import askSetup from '../../plugins/ask/index.js';
import btwSetup from '../../plugins/btw/index.js';
import browserCookieSyncSetup from '../../plugins/browser-cookie-sync/index.js';
import commitSetup from '../../plugins/commit/index.js';
import computerUseSetup from '../../plugins/computer-use/index.js';
import connectionsSetup from '../../plugins/connections/index.js';
import deepseekHarnessSetup from '../../plugins/deepseek-harness/index.js';
import evolutionSetup from '../../plugins/evolution/index.js';
import globalSearchSetup from '../../plugins/global-search/index.js';
import harnessReviewSetup from '../../plugins/harness-review/index.js';
import memorySetup from '../../plugins/memory/index.js';
import mobileRelaySetup from '../../plugins/mobile-relay/index.js';
import notebookSetup from '../../plugins/notebook/index.js';
import quickButtonsSetup from '../../plugins/quick-buttons/index.js';
import replyDigestSetup from '../../plugins/reply-digest/index.js';
import scheduleSetup from '../../plugins/schedule/index.js';
import sessionCompactSetup from '../../plugins/session-compact/index.js';
import sessionRenameSetup from '../../plugins/session-rename/index.js';
import sessionNotesSetup from '../../plugins/session-notes/index.js';
import sessionCopySetup from '../../plugins/session-copy/index.js';
import sessionTagsSetup from '../../plugins/session-tags/index.js';
import sidecarSetup from '../../plugins/sidecar/index.js';
import sshSetup from '../../plugins/ssh/index.js';
import subagentSetup from '../../plugins/subagent/index.js';
import todoSetup from '../../plugins/todo/index.js';
import videoSetup from '../../plugins/video/index.js';
import webSearchSetup from '../../plugins/web-search/index.js';
import { officialPluginManifests } from './manifests.js';

export { OFFICIAL_PLUGINS_DIR, officialPluginIds, officialPluginManifests } from './manifests.js';

/**
 * 官方插件（入口 + 清单）的静态登记表。
 *
 * 只有真正要跑插件的地方（CLI 交互启动、headless）才导入这个入口：它把插件的实现一起拉
 * 进来。只想列清单的地方用 `./manifests.js`。
 */
const officialSetups: Record<string, MicaPlugin['setup']> = {
  'session-compact': sessionCompactSetup,
  ask: askSetup,
  btw: btwSetup,
  'browser-cookie-sync': browserCookieSyncSetup,
  commit: commitSetup,
  'harness-review': harnessReviewSetup,
  memory: memorySetup,
  'web-search': webSearchSetup,
  todo: todoSetup,
  'session-notes': sessionNotesSetup,
  'session-copy': sessionCopySetup,
  'session-rename': sessionRenameSetup,
  'session-tags': sessionTagsSetup,
  sidecar: sidecarSetup,
  ssh: sshSetup,
  subagent: subagentSetup,
  'computer-use': computerUseSetup,
  connections: connectionsSetup,
  'deepseek-harness': deepseekHarnessSetup,
  evolution: evolutionSetup,
  'global-search': globalSearchSetup,
  'mobile-relay': mobileRelaySetup,
  notebook: notebookSetup,
  'quick-buttons': quickButtonsSetup,
  'reply-digest': replyDigestSetup,
  schedule: scheduleSetup,
  video: videoSetup,
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
