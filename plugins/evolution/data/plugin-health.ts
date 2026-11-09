import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { DataMigration } from './types.js';

export const pluginStartupHealth: DataMigration = {
  id: 'plugin-startup-health',
  description: 'Archive legacy setup errors from runtime plugin health; setup status belongs to the host',
  run({ home }) {
    const root = join(home, 'plugin-health');
    let names: string[];
    try {
      if (!lstatSync(root).isDirectory()) return 0;
      names = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let changed = 0;
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) continue;
      const path = join(root, name);
      const release = acquireProcessLock(`${path}.lock`);
      if (!release) continue;
      try {
        let record: unknown;
        try {
          if (!lstatSync(path).isFile()) continue;
          record = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const health = record as Record<string, unknown>;
        if (health.level !== 'error' || typeof health.message !== 'string' || !health.message.startsWith('启动失败：'))
          continue;
        const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-health');
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        renameSync(path, join(archive, `${name.slice(0, -5)}-${randomUUID()}.json`));
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};
