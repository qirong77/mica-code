import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { DataMigration } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Add the persisted site collections to Floating Window's existing data file. */
export const floatingWindowFavorites: DataMigration = {
  id: 'floatingwindow-favorites',
  description: '给已有 Floating Window 数据补上收藏站点和 favicon 集合',
  run({ home }) {
    const file = join(home, 'plugin-data', 'floatingwindow', 'data.json');
    try {
      if (!lstatSync(file).isFile()) return 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
      throw error;
    }
    const release = acquireProcessLock(`${file}.lock`);
    if (!release) return 0;
    try {
      const raw = readFileSync(file, 'utf8');
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) return 0;
      let changed = false;
      if (!Object.hasOwn(value, 'favoriteUrls')) {
        value.favoriteUrls = [];
        changed = true;
      }
      if (!Object.hasOwn(value, 'favicons')) {
        value.favicons = {};
        changed = true;
      }
      if (!changed) return 0;
      writeTextFileAtomic(file, `${JSON.stringify(value)}\n`);
      return 1;
    } catch (error) {
      if (error instanceof SyntaxError) return 0;
      throw error;
    } finally {
      release();
    }
  },
};
