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

function originKey(value: string): string {
  try { return new URL(value).origin; } catch { return value; }
}

/**
 * 图标原先按「保存的那条地址」存键；现在最近访问和收藏保存完整地址，图标改成按站点
 * origin 存一份，同一站点的多个地址共用一个键。同一 origin 的多个旧键只留第一个图标。
 */
export const floatingWindowIconOrigins: DataMigration = {
  id: 'floatingwindow-icon-origins',
  description: '把 Floating Window 的 favicon 集合从按地址存键改为按站点 origin 存键',
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
      if (!isRecord(value) || !isRecord(value.favicons)) return 0;
      const favicons: Record<string, unknown> = {};
      let changed = false;
      for (const [site, icon] of Object.entries(value.favicons)) {
        const key = originKey(site);
        if (key !== site) changed = true;
        if (Object.hasOwn(favicons, key)) { changed = true; continue; }
        favicons[key] = icon;
      }
      if (!changed) return 0;
      value.favicons = favicons;
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
