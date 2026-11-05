import { linkSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { DataMigration } from './types.js';

const SETTINGS_KEYS = ['browser', 'profile', 'toMica', 'toChrome', 'writeWhileRunning', 'everyMinutes'];
const STATUS_KEYS = ['lastRun', 'counts', 'access', 'attention'];

export const browserCookieSyncExtension: DataMigration = {
  id: 'browser-cookie-sync-extension',
  description: 'Archive browser-cookie-sync v1 settings and manual-sync state as legacy-v1 files',
  run({ home }) {
    const data = join(home, 'plugin-data', 'browser-cookie-sync');
    let changed = 0;
    for (const [file, keys] of [
      [join(home, 'plugin-settings', 'browser-cookie-sync.json'), SETTINGS_KEYS],
      [join(data, 'state.json'), [...SETTINGS_KEYS, ...STATUS_KEYS, 'target', 'baseline']],
      [join(data, 'data.json'), STATUS_KEYS],
    ] as const) {
      if (archiveLegacyFile(file, keys, file === join(data, 'data.json'))) changed += 1;
    }
    return changed;
  },
};

function archiveLegacyFile(file: string, keys: readonly string[], preserveConnection: boolean): boolean {
  let raw: unknown;
  try {
    if (!lstatSync(file).isFile()) return false;
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  if (!keys.some((key) => Object.hasOwn(record, key)) && !(preserveConnection && typeof record.target === 'string')) {
    return false;
  }

  const base = file.slice(0, -'.json'.length);
  for (let suffix = 0; ; suffix += 1) {
    const archive = `${base}.legacy-v1${suffix ? `.${suffix}` : ''}.json`;
    try {
      // A hard-link move refuses to overwrite an archive created by another host.
      linkSync(file, archive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    unlinkSync(file);
    if (preserveConnection) {
      const remaining = Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
      if (typeof remaining.target === 'string') delete remaining.target;
      if (Object.keys(remaining).length > 0) {
        writeTextFileAtomic(file, `${JSON.stringify(remaining, null, 2)}\n`);
      }
    }
    return true;
  }
}
