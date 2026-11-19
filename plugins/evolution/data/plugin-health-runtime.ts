import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import {
  archivePrivateOriginal,
  hasDataDirectory,
  readBoundedPrivateFile,
  replacePrivateFile,
} from './private-files.js';
import type { DataMigration } from './types.js';

const PRODUCERS_WITH_EXPLICIT_ISSUES = new Set([
  'memory',
  'web-search',
  'mobile-relay',
  'video',
  'computer-use',
  'reply-digest',
  'session-rename',
  'session-compact',
  'session-tags',
  'todo',
  'browser-cookie-sync',
  'evolution',
]);
// A frozen migration scope, not the current catalog: do not sweep arbitrary user plugins.
const OFFICIAL_MANAGER_PRODUCERS = new Set([
  ...PRODUCERS_WITH_EXPLICIT_ISSUES,
  'ask',
  'btw',
  'commit',
  'connections',
  'deepseek-harness',
  'global-search',
  'harness-review',
  'notebook',
  'quick-buttons',
  'schedule',
  'session-notes',
  'session-copy',
  'sidecar',
  'ssh',
  'subagent',
]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function managerMessage(message: string): boolean {
  return (
    /^常驻任务 .+ 失败：/.test(message) ||
    /^钩子 .+ 执行失败：/.test(message) ||
    message.startsWith('skill 未注册：') ||
    message.startsWith('skill 目录：') ||
    message === '清单声明了 skills，但插件不是从目录加载的，读不到 skill 正文' ||
    message.startsWith('配置不完整：') ||
    message.startsWith('角色目录：') ||
    message === '清单声明了 roles，但插件不是从目录加载的，读不到角色正文'
  );
}

export const pluginHealthRuntimeHistory: DataMigration = {
  id: 'plugin-health-runtime-history',
  description: 'Archive superseded default health slots as unknown history, preserving independent active issues',
  run({ home, log }) {
    if (!hasDataDirectory(home, 'plugin-health')) return 0;
    let changed = 0;
    for (const pluginId of OFFICIAL_MANAGER_PRODUCERS) {
      const path = join(home, 'plugin-health', `${pluginId}.json`);
      try {
        if (!lstatSync(path).isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const release = acquireProcessLock(`${path}.lock`);
      if (!release) continue;
      try {
        // The document must be read after acquiring the same lock as health writers.
        const original = readBoundedPrivateFile(path, 256 * 1024);
        if (!original) continue;
        const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
        if (!object(document) || document.schemaVersion !== 2 || !object(document.issues)) continue;
        const runtime = document.issues.runtime;
        if (
          !object(runtime) ||
          typeof runtime.message !== 'string' ||
          !['ok', 'warn', 'error'].includes(String(runtime.level)) ||
          (runtime.issueKey !== undefined && runtime.issueKey !== 'runtime')
        )
          continue;
        if (!PRODUCERS_WITH_EXPLICIT_ISSUES.has(pluginId) && !managerMessage(runtime.message)) continue;
        archivePrivateOriginal(home, 'legacy-plugin-health-runtime', `${pluginId}.json`, original);
        delete document.issues.runtime;
        // No synthetic ok, recovery time or new issue mapping: absence means unknown.
        replacePrivateFile(path, `${JSON.stringify(document, null, 2)}\n`);
        changed += 1;
      } catch {
        log('evolution:plugin-health-runtime-skipped', { pluginId, reason: 'unreadable_or_unsupported' });
      } finally {
        release();
      }
    }
    return changed;
  },
};
